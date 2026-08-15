import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  GroupListGroupDto,
  SavedGroupListDto,
} from '../../contracts/group-lists/group-list.dto';
import { DatabaseService } from '../../core/database/database.service';

interface GroupListRow {
  id: string;
  session_id: string;
  name: string;
  description: string | null;
  group_count: string | number;
  revision: string | number;
  membership_revision: string | number;
  create_request_hash: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface GroupListGroupRow {
  group_id: string;
  group_name: string;
  is_active: boolean;
  participants_count: number | null;
  send_capability: 'ALLOWED' | 'DENIED' | 'UNKNOWN';
  send_capability_reason: string;
  capability_checked_at: Date | null;
  capability_invalidated_at: Date | null;
  capability_revision: number;
}

interface GroupValidation {
  missingGroupIds: string[];
  mismatchedGroupIds: string[];
}

interface MutationResult extends GroupValidation {
  list: SavedGroupListDto | null;
  groups?: GroupListGroupDto[];
  revisionConflict?: boolean;
}

interface CreateResult extends MutationResult {
  created: boolean;
  requestHash: string | null;
  sessionFound: boolean;
}

const listSelect = `
  SELECT gl.*,
    (SELECT count(*) FROM group_list_items gli WHERE gli.group_list_id = gl.id) AS group_count
  FROM group_lists gl`;

const mapList = (row: GroupListRow): SavedGroupListDto => ({
  id: row.id,
  sessionId: row.session_id,
  name: row.name,
  description: row.description,
  groupCount: Number(row.group_count),
  revision: Number(row.revision),
  membershipRevision: Number(row.membership_revision),
  archivedAt: row.archived_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapGroup = (row: GroupListGroupRow): GroupListGroupDto => ({
  groupId: row.group_id,
  groupName: row.group_name,
  isActive: row.is_active,
  participantsCount: row.participants_count,
  sendCapability: {
    status: row.send_capability,
    reason: row.send_capability_reason,
    checkedAt: row.capability_checked_at,
    invalidatedAt: row.capability_invalidated_at,
    revision: Number(row.capability_revision),
  },
});

@Injectable()
export class GroupListRepository {
  constructor(private readonly database: DatabaseService) {}

  async list(input: { sessionId: string; query?: string; limit: number; offset: number }) {
    const normalizedQuery = input.query?.trim();
    const searchPattern = normalizedQuery
      ? `%${normalizedQuery.replace(/[\\%_]/g, '\\$&')}%`
      : null;
    return this.database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const values = [input.sessionId, searchPattern];
      const predicate = `gl.session_id = $1 AND gl.archived_at IS NULL
        AND ($2::text IS NULL OR gl.name ILIKE $2 ESCAPE '\\'
          OR coalesce(gl.description, '') ILIKE $2 ESCAPE '\\')`;
      const rows = await client.query<GroupListRow>(
        `${listSelect} WHERE ${predicate}
         ORDER BY gl.updated_at DESC, gl.id ASC LIMIT $3 OFFSET $4`,
        [...values, input.limit, input.offset],
      );
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM group_lists gl WHERE ${predicate}`,
        values,
      );
      return { data: rows.rows.map(mapList), total: Number(count.rows[0]?.count ?? 0) };
    });
  }

  async find(id: string, includeArchived = false): Promise<SavedGroupListDto | null> {
    const result = await this.database.query<GroupListRow>(
      `${listSelect} WHERE gl.id = $1${includeArchived ? '' : ' AND gl.archived_at IS NULL'}`,
      [id],
    );
    return result.rows[0] ? mapList(result.rows[0]) : null;
  }

  async create(input: {
    sessionId: string;
    name: string;
    description: string | null;
    groupIds: string[];
    idempotencyKey: string;
    requestHash: string;
  }): Promise<CreateResult> {
    return this.database.transaction(async client => {
      const existing = await client.query<GroupListRow>(
        `${listSelect} WHERE gl.create_idempotency_key = $1::uuid FOR UPDATE OF gl`,
        [input.idempotencyKey],
      );
      if (existing.rows[0]) {
        return {
          list: mapList(existing.rows[0]),
          created: false,
          requestHash: existing.rows[0].create_request_hash,
          sessionFound: true,
          missingGroupIds: [],
          mismatchedGroupIds: [],
        };
      }

      const session = await client.query('SELECT 1 FROM gateway_sessions WHERE id = $1 FOR SHARE', [input.sessionId]);
      if (session.rowCount !== 1) {
        return {
          list: null, created: false, requestHash: null, sessionFound: false,
          missingGroupIds: [], mismatchedGroupIds: [],
        };
      }
      const validation = await this.validateGroups(client, input.sessionId, input.groupIds);
      if (validation.missingGroupIds.length || validation.mismatchedGroupIds.length) {
        return { list: null, created: false, requestHash: null, sessionFound: true, ...validation };
      }

      const inserted = await client.query<GroupListRow>(
        `INSERT INTO group_lists
           (session_id, name, description, create_idempotency_key, create_request_hash)
         VALUES ($1, $2, $3, $4::uuid, $5)
         ON CONFLICT (create_idempotency_key) WHERE create_idempotency_key IS NOT NULL DO NOTHING
         RETURNING *, 0 AS group_count`,
        [input.sessionId, input.name, input.description, input.idempotencyKey, input.requestHash],
      );
      if (!inserted.rows[0]) {
        const replay = await client.query<GroupListRow>(
          `${listSelect} WHERE gl.create_idempotency_key = $1::uuid FOR UPDATE OF gl`,
          [input.idempotencyKey],
        );
        const row = replay.rows[0]!;
        return {
          list: mapList(row), created: false, requestHash: row.create_request_hash,
          sessionFound: true, missingGroupIds: [], mismatchedGroupIds: [],
        };
      }

      const row = inserted.rows[0];
      await this.insertItems(client, row.id, input.sessionId, input.groupIds);
      return {
        list: { ...mapList(row), groupCount: input.groupIds.length },
        created: true,
        requestHash: input.requestHash,
        sessionFound: true,
        missingGroupIds: [],
        mismatchedGroupIds: [],
      };
    });
  }

  async update(
    id: string,
    input: { name: string; description: string | null },
    expectedRevision: number,
  ): Promise<SavedGroupListDto | null> {
    const result = await this.database.query<GroupListRow>(
      `WITH updated AS (
         UPDATE group_lists
         SET name = $2, description = $3,
           revision = revision + CASE WHEN (name, description) IS DISTINCT FROM ($2, $3) THEN 1 ELSE 0 END,
           updated_at = CASE WHEN (name, description) IS DISTINCT FROM ($2, $3) THEN now() ELSE updated_at END
         WHERE id = $1 AND archived_at IS NULL AND revision = $4
         RETURNING *
       )
       SELECT updated.*,
         (SELECT count(*) FROM group_list_items gli WHERE gli.group_list_id = updated.id) AS group_count
       FROM updated`,
      [id, input.name, input.description, expectedRevision],
    );
    return result.rows[0] ? mapList(result.rows[0]) : null;
  }

  async archive(id: string, expectedRevision: number): Promise<SavedGroupListDto | null> {
    const result = await this.database.query<GroupListRow>(
      `WITH archived AS (
         UPDATE group_lists
         SET archived_at = now(), revision = revision + 1, updated_at = now()
         WHERE id = $1 AND archived_at IS NULL AND revision = $2
         RETURNING *
       )
       SELECT archived.*,
         (SELECT count(*) FROM group_list_items gli WHERE gli.group_list_id = archived.id) AS group_count
       FROM archived`,
      [id, expectedRevision],
    );
    return result.rows[0] ? mapList(result.rows[0]) : null;
  }

  async getMembership(id: string): Promise<{
    list: SavedGroupListDto;
    groups: GroupListGroupDto[];
  } | null> {
    return this.database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const listResult = await client.query<GroupListRow>(
        `${listSelect} WHERE gl.id = $1 AND gl.archived_at IS NULL`,
        [id],
      );
      if (!listResult.rows[0]) return null;
      return {
        list: mapList(listResult.rows[0]),
        groups: await this.listGroupsWithClient(client, id),
      };
    });
  }

  async replaceGroups(
    id: string,
    groupIds: string[],
    expectedRevision: number,
    expectedMembershipRevision?: number,
  ): Promise<MutationResult> {
    return this.database.transaction(async client => {
      const listResult = await client.query<{ session_id: string; revision: string; membership_revision: string }>(
        `SELECT session_id, revision::text, membership_revision::text
         FROM group_lists WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
        [id],
      );
      const list = listResult.rows[0];
      if (!list) return { list: null, missingGroupIds: [], mismatchedGroupIds: [] };
      if (Number(list.revision) !== expectedRevision
        || (expectedMembershipRevision !== undefined
          && Number(list.membership_revision) !== expectedMembershipRevision)) {
        return { list: null, missingGroupIds: [], mismatchedGroupIds: [], revisionConflict: true };
      }

      const validation = await this.validateGroups(client, list.session_id, groupIds);
      if (validation.missingGroupIds.length || validation.mismatchedGroupIds.length) {
        return { list: null, ...validation };
      }
      const currentResult = await client.query<{ group_id: string }>(
        'SELECT group_id FROM group_list_items WHERE group_list_id = $1 ORDER BY group_id FOR UPDATE',
        [id],
      );
      const current = currentResult.rows.map(row => row.group_id);
      const next = [...groupIds].sort();
      const changed = current.length !== next.length || current.some((value, index) => value !== next[index]);
      if (changed) {
        await client.query('DELETE FROM group_list_items WHERE group_list_id = $1', [id]);
        await this.insertItems(client, id, list.session_id, next);
        await client.query(
          `UPDATE group_lists SET revision = revision + 1,
             membership_revision = membership_revision + 1, updated_at = now() WHERE id = $1`,
          [id],
        );
      }
      const refreshed = await client.query<GroupListRow>(`${listSelect} WHERE gl.id = $1`, [id]);
      return {
        list: mapList(refreshed.rows[0]!),
        groups: await this.listGroupsWithClient(client, id),
        missingGroupIds: [],
        mismatchedGroupIds: [],
      };
    });
  }

  async lockMembershipSnapshot(client: PoolClient, id: string): Promise<{
    id: string;
    name: string;
    sessionId: string;
    revision: number;
    membershipRevision: number;
    groupIds: string[];
  } | null> {
    const list = await client.query<{
      id: string;
      name: string;
      session_id: string;
      revision: string;
      membership_revision: string;
    }>(
      `SELECT id, name, session_id, revision::text, membership_revision::text
       FROM group_lists WHERE id = $1 AND archived_at IS NULL FOR SHARE`,
      [id],
    );
    const row = list.rows[0];
    if (!row) return null;
    const membership = await client.query<{ group_id: string }>(
      'SELECT group_id FROM group_list_items WHERE group_list_id = $1 ORDER BY group_id',
      [id],
    );
    return {
      id: row.id,
      name: row.name,
      sessionId: row.session_id,
      revision: Number(row.revision),
      membershipRevision: Number(row.membership_revision),
      groupIds: membership.rows.map(item => item.group_id),
    };
  }

  private async validateGroups(
    client: PoolClient,
    sessionId: string,
    groupIds: string[],
  ): Promise<GroupValidation> {
    if (!groupIds.length) return { missingGroupIds: [], mismatchedGroupIds: [] };
    const result = await client.query<{ id: string; session_id: string }>(
      'SELECT id, session_id FROM gateway_groups WHERE id = ANY($1::text[]) FOR SHARE',
      [groupIds],
    );
    const found = new Map<string, boolean>();
    for (const row of result.rows) {
      found.set(row.id, (found.get(row.id) ?? false) || row.session_id === sessionId);
    }
    return {
      missingGroupIds: groupIds.filter(groupId => !found.has(groupId)),
      mismatchedGroupIds: groupIds.filter(groupId => found.get(groupId) === false),
    };
  }

  private async insertItems(
    client: PoolClient,
    listId: string,
    sessionId: string,
    groupIds: string[],
  ): Promise<void> {
    if (!groupIds.length) return;
    await client.query(
      `INSERT INTO group_list_items (group_list_id, session_id, group_id)
       SELECT $1, $2, group_id FROM unnest($3::text[]) AS group_id`,
      [listId, sessionId, groupIds],
    );
  }

  private async listGroupsWithClient(client: PoolClient, id: string): Promise<GroupListGroupDto[]> {
    const result = await client.query<GroupListGroupRow>(
      `${this.groupMembershipSelect()} WHERE gli.group_list_id = $1
       ORDER BY lower(g.name) ASC, g.id ASC`,
      [id],
    );
    return result.rows.map(mapGroup);
  }

  private groupMembershipSelect(): string {
    return `SELECT gli.group_id, g.name AS group_name, g.is_active, g.participants_count,
      g.send_capability, g.send_capability_reason, g.capability_checked_at,
      g.capability_invalidated_at, g.capability_revision
    FROM group_list_items gli
    JOIN gateway_groups g ON g.session_id = gli.session_id AND g.id = gli.group_id`;
  }
}
