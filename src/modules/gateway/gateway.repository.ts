import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { GroupDto, GroupMemberDto } from '../../contracts/groups/group.dto';
import type { GroupQueryDto } from '../../contracts/groups/group-query.dto';
import type { SessionDto } from '../../contracts/sessions/session.dto';
import type { SyncRunDto, SyncRunStatus } from '../../contracts/sessions/sync-run.dto';
import { DatabaseService } from '../../core/database/database.service';
import {
  pendingGroupName,
  type OpenWAGroup,
  type OpenWAGroupSummary,
  type OpenWASession,
} from '../../integrations/openwa/openwa.client';
import { evaluateGroupCapability, type GroupSendCapabilityReason, type GroupSendCapabilityStatus } from './group-capability';

interface SessionRow {
  id: string;
  name: string;
  status: string;
  phone: string | null;
  push_name: string | null;
  connected_at: Date | null;
  last_active_at: Date | null;
  engine_loaded: boolean;
  last_error: string | null;
  restriction: Record<string, unknown> | null;
  gateway_created_at: Date;
  gateway_updated_at: Date;
  synced_at: Date;
}

interface GroupRow {
  session_id: string;
  id: string;
  name: string;
  description: string | null;
  owner_id: string | null;
  linked_parent_id: string | null;
  participants_count: number | null;
  is_admin: boolean | null;
  is_read_only: boolean | null;
  is_announce: boolean | null;
  settings_locked: boolean | null;
  is_active: boolean;
  details_synced_at: Date | null;
  synced_at: Date;
  send_capability: GroupSendCapabilityStatus;
  send_capability_reason: string;
  capability_checked_at: Date | null;
  capability_invalidated_at: Date | null;
  capability_revision: number;
  capability_refresh_attempt_count: number;
  capability_refresh_lease_token: string | null;
  capability_refresh_lease_expires_at: Date | null;
  capability_refresh_lease_valid?: boolean;
}

interface MemberRow {
  participant_id: string;
  phone_number: string;
  display_name: string | null;
  is_admin: boolean;
  is_super_admin: boolean;
}

interface SyncRunRow {
  id: string;
  session_id: string;
  sync_type: string;
  status: SyncRunStatus;
  groups_synced: number;
  members_synced: number;
  error: string | null;
  requested_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

export interface ClaimedSyncRun {
  sessionId: string;
  leaseToken: string;
  attemptNumber: number;
  syncEpoch: string;
}

export interface SyncWriteFence {
  syncRunId: string;
  leaseToken: string;
  syncEpoch: string;
}

export type SyncAttemptResult = 'PENDING' | 'FAILED' | 'LOST_OWNERSHIP';

export interface ClaimedCapabilityRefresh {
  leaseToken: string;
  attemptNumber: number;
}

export type CapabilityRefreshAttemptResult = 'RETRY' | 'FAILED' | 'LOST_OWNERSHIP';

const mapSession = (row: SessionRow): SessionDto => ({
  id: row.id,
  name: row.name,
  status: row.status,
  phone: row.phone,
  pushName: row.push_name,
  connectedAt: row.connected_at,
  lastActiveAt: row.last_active_at,
  engineLoaded: row.engine_loaded,
  lastError: row.last_error,
  restriction: row.restriction,
  gatewayCreatedAt: row.gateway_created_at,
  gatewayUpdatedAt: row.gateway_updated_at,
  syncedAt: row.synced_at,
});

const mapGroup = (row: GroupRow): GroupDto => ({
  sessionId: row.session_id,
  id: row.id,
  name: row.name,
  description: row.description,
  ownerId: row.owner_id,
  linkedParentId: row.linked_parent_id,
  participantsCount: row.participants_count,
  isAdmin: row.is_admin,
  isReadOnly: row.is_read_only,
  isAnnounce: row.is_announce,
  settingsLocked: row.settings_locked,
  isActive: row.is_active,
  detailsSyncedAt: row.details_synced_at,
  syncedAt: row.synced_at,
  sendCapability: {
    status: row.send_capability,
    reason: row.send_capability_reason,
    checkedAt: row.capability_checked_at,
    invalidatedAt: row.capability_invalidated_at,
    revision: row.capability_revision,
  },
});

const mapMember = (row: MemberRow): GroupMemberDto => ({
  participantId: row.participant_id,
  phoneNumber: row.phone_number,
  displayName: row.display_name,
  isAdmin: row.is_admin,
  isSuperAdmin: row.is_super_admin,
});

const mapSyncRun = (row: SyncRunRow): SyncRunDto => ({
  id: row.id,
  sessionId: row.session_id,
  syncType: row.sync_type,
  status: row.status,
  groupsSynced: row.groups_synced,
  membersSynced: row.members_synced,
  error: row.error,
  requestedAt: row.requested_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
});

@Injectable()
export class GatewayRepository {
  constructor(private readonly database: DatabaseService) {}

  async upsertSession(session: OpenWASession, syncFence?: SyncWriteFence): Promise<SessionDto> {
    const sql = `INSERT INTO gateway_sessions
         (id, name, status, phone, push_name, connected_at, last_active_at, engine_loaded,
         last_error, restriction, gateway_created_at, gateway_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, status = EXCLUDED.status, phone = EXCLUDED.phone,
         push_name = EXCLUDED.push_name, connected_at = EXCLUDED.connected_at,
         last_active_at = EXCLUDED.last_active_at, engine_loaded = EXCLUDED.engine_loaded,
         last_error = EXCLUDED.last_error, restriction = EXCLUDED.restriction,
         gateway_updated_at = EXCLUDED.gateway_updated_at,
         synced_at = now(), updated_at = now()
       RETURNING *`;
    const values = [session.id, session.name, session.status, session.phone ?? null, session.pushName ?? null,
      session.connectedAt ?? null, session.lastActive ?? null, session.engineLoaded,
      session.lastError ?? null, session.restriction == null ? null : JSON.stringify(session.restriction),
      session.createdAt, session.updatedAt];
    if (syncFence) {
      return this.database.transaction(async client => {
        await this.assertSyncWriteOwnership(client, session.id, syncFence);
        const result = await client.query<SessionRow>(sql, values);
        return mapSession(result.rows[0]!);
      });
    }
    const result = await this.database.query<SessionRow>(sql, values);
    return mapSession(result.rows[0]!);
  }

  async listSessions(allowedIds: string[]): Promise<SessionDto[]> {
    const result = await this.database.query<SessionRow>(
      'SELECT * FROM gateway_sessions WHERE id = ANY($1::text[]) ORDER BY name, id', [allowedIds],
    );
    return result.rows.map(mapSession);
  }

  async findSession(id: string): Promise<SessionDto | null> {
    const result = await this.database.query<SessionRow>('SELECT * FROM gateway_sessions WHERE id = $1', [id]);
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async isSessionSendable(id: string): Promise<boolean> {
    const result = await this.database.query<{ sendable: boolean }>(
      `SELECT status = 'ready' AND engine_loaded = true AND restriction IS NULL AS sendable
       FROM gateway_sessions WHERE id = $1`, [id],
    );
    return result.rows[0]?.sendable === true;
  }

  async replaceGroupSummaries(
    sessionId: string,
    groups: OpenWAGroupSummary[],
    syncFence: SyncWriteFence,
  ): Promise<void> {
    await this.database.transaction(async client => {
      await this.assertSyncWriteOwnership(client, sessionId, syncFence);
      await client.query('UPDATE gateway_groups SET is_active = false, updated_at = now() WHERE session_id = $1', [sessionId]);
      if (groups.length > 0) {
        await client.query(
          `INSERT INTO gateway_groups
             (session_id, id, name, participants_count, is_admin, linked_parent_id)
           SELECT $1, summary.id, summary.name, summary.participants_count,
             summary.is_admin, summary.linked_parent_id
           FROM jsonb_to_recordset($2::jsonb) AS summary(
             id text, name text, participants_count integer, is_admin boolean, linked_parent_id text
           )
           ON CONFLICT (session_id, id) DO UPDATE SET
             name = CASE WHEN EXCLUDED.name = $3 AND gateway_groups.details_synced_at IS NOT NULL
               THEN gateway_groups.name ELSE EXCLUDED.name END,
             participants_count = COALESCE(EXCLUDED.participants_count, gateway_groups.participants_count),
             is_admin = COALESCE(EXCLUDED.is_admin, gateway_groups.is_admin),
             linked_parent_id = EXCLUDED.linked_parent_id,
             send_capability = CASE WHEN gateway_groups.is_active = false
               THEN 'UNKNOWN' ELSE gateway_groups.send_capability END,
             send_capability_reason = CASE WHEN gateway_groups.is_active = false
               THEN 'GROUP_CHANGED' ELSE gateway_groups.send_capability_reason END,
             capability_invalidated_at = CASE WHEN gateway_groups.is_active = false
               THEN now() ELSE gateway_groups.capability_invalidated_at END,
             capability_revision = CASE WHEN gateway_groups.is_active = false
               THEN gateway_groups.capability_revision + 1 ELSE gateway_groups.capability_revision END,
             is_active = true, synced_at = now(), updated_at = now()`,
          [sessionId, JSON.stringify(groups.map(group => ({
            id: group.id,
            name: group.name,
            participants_count: group.participantsCount ?? null,
            is_admin: group.isAdmin ?? null,
            linked_parent_id: group.linkedParentJID ?? null,
          }))), pendingGroupName],
        );
      }
      await client.query(
        `UPDATE gateway_groups SET
           send_capability = 'DENIED', send_capability_reason = 'GROUP_INACTIVE',
           capability_checked_at = now(), capability_invalidated_at = NULL,
           capability_revision = capability_revision + 1, updated_at = now()
         WHERE session_id = $1 AND is_active = false
           AND (send_capability <> 'DENIED' OR send_capability_reason <> 'GROUP_INACTIVE')`,
        [sessionId],
      );
    });
  }

  async upsertGroupDetails(
    sessionId: string,
    group: OpenWAGroup,
    options: {
      expectedRevision?: number;
      capabilityLeaseToken?: string;
      syncFence?: SyncWriteFence;
    } = {},
  ): Promise<{ members: number; applied: boolean }> {
    return this.database.transaction(async client => {
      if (options.syncFence) await this.assertSyncWriteOwnership(client, sessionId, options.syncFence);
      const existingResult = await client.query<GroupRow>(
        `SELECT *, capability_refresh_lease_expires_at > now() AS capability_refresh_lease_valid
         FROM gateway_groups WHERE session_id = $1 AND id = $2 FOR UPDATE`,
        [sessionId, group.id],
      );
      const existing = existingResult.rows[0];
      if (options.expectedRevision !== undefined && existing?.capability_revision !== options.expectedRevision) {
        return { members: 0, applied: false };
      }
      if (options.capabilityLeaseToken !== undefined
        && (existing?.capability_refresh_lease_token !== options.capabilityLeaseToken
          || existing.capability_refresh_lease_valid !== true)) {
        return { members: 0, applied: false };
      }
      const isAdmin = group.isAdmin ?? existing?.is_admin ?? null;
      const isReadOnly = group.isReadOnly ?? null;
      const isAnnounce = group.announce ?? group.isAnnounce ?? null;
      const capability = evaluateGroupCapability({
        isActive: true,
        isReadOnly,
        isAnnounce,
        isAdmin,
        hasDetails: true,
      });
      await client.query(
        `INSERT INTO gateway_groups
           (session_id, id, name, description, owner_id, linked_parent_id, participants_count,
            is_admin, is_read_only, is_announce, settings_locked, ephemeral_seconds,
            member_add_mode, gateway_created_at, details_synced_at, send_capability,
            send_capability_reason, capability_checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 CASE WHEN $14::bigint IS NULL THEN NULL ELSE to_timestamp($14::bigint) END,
                 now(),$15,$16,now())
         ON CONFLICT (session_id, id) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description, owner_id = EXCLUDED.owner_id,
           linked_parent_id = EXCLUDED.linked_parent_id, participants_count = EXCLUDED.participants_count,
           is_admin = COALESCE(EXCLUDED.is_admin, gateway_groups.is_admin),
           is_read_only = EXCLUDED.is_read_only, is_announce = EXCLUDED.is_announce,
           settings_locked = EXCLUDED.settings_locked, ephemeral_seconds = EXCLUDED.ephemeral_seconds,
           member_add_mode = EXCLUDED.member_add_mode, gateway_created_at = EXCLUDED.gateway_created_at,
           send_capability = EXCLUDED.send_capability,
           send_capability_reason = EXCLUDED.send_capability_reason,
           capability_checked_at = now(), capability_invalidated_at = NULL,
           capability_refresh_attempt_count = 0, capability_refresh_next_attempt_at = now(),
           capability_refresh_lease_token = NULL, capability_refresh_lease_expires_at = NULL,
           capability_refresh_error = NULL,
           capability_revision = CASE
             WHEN gateway_groups.send_capability IS DISTINCT FROM EXCLUDED.send_capability
               OR gateway_groups.send_capability_reason IS DISTINCT FROM EXCLUDED.send_capability_reason
             THEN gateway_groups.capability_revision + 1
             ELSE gateway_groups.capability_revision
           END,
           is_active = true, details_synced_at = now(), synced_at = now(), updated_at = now()`,
        [sessionId, group.id, group.name, group.description ?? null, group.owner ?? null,
          group.linkedParentJID ?? null, group.participants.length, isAdmin,
          isReadOnly, isAnnounce, group.locked ?? null,
          group.ephemeralSeconds ?? null, group.memberAddMode ?? null, group.createdAt ?? null,
          capability.status, capability.reason],
      );
      await client.query('DELETE FROM group_members WHERE session_id = $1 AND group_id = $2', [sessionId, group.id]);
      if (group.participants.length > 0) {
        await client.query(
          `INSERT INTO group_members
             (session_id, group_id, participant_id, phone_number, display_name, is_admin, is_super_admin)
           SELECT $1, $2, participant_id, phone_number, display_name, is_admin, is_super_admin
           FROM unnest($3::text[], $4::text[], $5::text[], $6::boolean[], $7::boolean[])
             AS participant(participant_id, phone_number, display_name, is_admin, is_super_admin)`,
          [
            sessionId,
            group.id,
            group.participants.map(participant => participant.id),
            group.participants.map(participant => participant.number),
            group.participants.map(participant => participant.name ?? null),
            group.participants.map(participant => participant.isAdmin),
            group.participants.map(participant => participant.isSuperAdmin),
          ],
        );
      }
      return { members: group.participants.length, applied: true };
    });
  }

  async invalidateGroupCapability(
    sessionId: string,
    groupId: string,
    reason: GroupSendCapabilityReason,
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE gateway_groups SET send_capability = 'UNKNOWN', send_capability_reason = $3,
         capability_invalidated_at = now(), capability_revision = capability_revision + 1,
         capability_refresh_attempt_count = 0, capability_refresh_next_attempt_at = now(),
         capability_refresh_lease_token = NULL, capability_refresh_lease_expires_at = NULL,
         capability_refresh_error = NULL,
         updated_at = now()
       WHERE session_id = $1 AND id = $2 AND is_active = true`,
      [sessionId, groupId, reason],
    );
    return result.rowCount === 1;
  }

  async listGroupsNeedingCapabilityRefresh(limit: number): Promise<Array<{
    sessionId: string;
    groupId: string;
    revision: number;
  }>> {
    const result = await this.database.query<{
      session_id: string;
      id: string;
      capability_revision: number;
    }>(
      `SELECT session_id, id, capability_revision FROM gateway_groups
       WHERE is_active = true AND capability_invalidated_at IS NOT NULL
         AND capability_refresh_attempt_count < 3
         AND capability_refresh_next_attempt_at <= now()
         AND (capability_refresh_lease_token IS NULL OR capability_refresh_lease_expires_at < now())
         AND NOT EXISTS (
           SELECT 1 FROM sync_runs
           WHERE sync_runs.session_id = gateway_groups.session_id
             AND sync_runs.status IN ('PENDING', 'RUNNING')
         )
       ORDER BY capability_refresh_next_attempt_at, capability_invalidated_at LIMIT $1`,
      [limit],
    );
    return result.rows.map(row => ({
      sessionId: row.session_id,
      groupId: row.id,
      revision: row.capability_revision,
    }));
  }

  async claimCapabilityRefresh(
    sessionId: string,
    groupId: string,
    expectedRevision: number,
  ): Promise<ClaimedCapabilityRefresh | null> {
    const result = await this.database.query<{
      capability_refresh_lease_token: string;
      capability_refresh_attempt_count: number;
    }>(
      `UPDATE gateway_groups SET
         capability_refresh_attempt_count = capability_refresh_attempt_count + 1,
         capability_refresh_lease_token = gen_random_uuid(),
         capability_refresh_lease_expires_at = now() + interval '2 minutes',
         capability_refresh_error = NULL, updated_at = now()
       WHERE session_id = $1 AND id = $2 AND capability_revision = $3
         AND is_active = true AND capability_invalidated_at IS NOT NULL
         AND capability_refresh_attempt_count < 3
         AND capability_refresh_next_attempt_at <= now()
         AND (capability_refresh_lease_token IS NULL OR capability_refresh_lease_expires_at < now())
         AND NOT EXISTS (
           SELECT 1 FROM sync_runs
           WHERE sync_runs.session_id = gateway_groups.session_id
             AND sync_runs.status IN ('PENDING', 'RUNNING')
         )
       RETURNING capability_refresh_lease_token, capability_refresh_attempt_count`,
      [sessionId, groupId, expectedRevision],
    );
    const row = result.rows[0];
    return row ? {
      leaseToken: row.capability_refresh_lease_token,
      attemptNumber: row.capability_refresh_attempt_count,
    } : null;
  }

  async failCapabilityRefreshAttempt(
    sessionId: string,
    groupId: string,
    expectedRevision: number,
    leaseToken: string,
    error: string,
  ): Promise<CapabilityRefreshAttemptResult> {
    const result = await this.database.query<{ exhausted: boolean }>(
      `UPDATE gateway_groups SET
         send_capability = 'UNKNOWN',
         send_capability_reason = CASE WHEN capability_refresh_attempt_count >= 3
           THEN 'REFRESH_FAILED' ELSE send_capability_reason END,
         capability_checked_at = CASE WHEN capability_refresh_attempt_count >= 3
           THEN now() ELSE capability_checked_at END,
         capability_invalidated_at = CASE WHEN capability_refresh_attempt_count >= 3
           THEN NULL ELSE capability_invalidated_at END,
         capability_refresh_next_attempt_at = CASE WHEN capability_refresh_attempt_count >= 3
           THEN capability_refresh_next_attempt_at
           ELSE now() + LEAST(300, 5 * power(2, capability_refresh_attempt_count - 1)) * interval '1 second' END,
         capability_refresh_lease_token = NULL, capability_refresh_lease_expires_at = NULL,
         capability_refresh_error = $5, updated_at = now()
       WHERE session_id = $1 AND id = $2 AND capability_revision = $3
         AND capability_refresh_lease_token = $4 AND capability_refresh_lease_expires_at > now()
       RETURNING capability_refresh_attempt_count >= 3 AS exhausted`,
      [sessionId, groupId, expectedRevision, leaseToken, error],
    );
    const row = result.rows[0];
    return row ? (row.exhausted ? 'FAILED' : 'RETRY') : 'LOST_OWNERSHIP';
  }

  async recoverExpiredCapabilityRefreshes(): Promise<number> {
    const result = await this.database.query(
      `UPDATE gateway_groups SET
         send_capability = 'UNKNOWN',
         send_capability_reason = CASE WHEN capability_refresh_attempt_count >= 3
           THEN 'REFRESH_FAILED' ELSE send_capability_reason END,
         capability_checked_at = CASE WHEN capability_refresh_attempt_count >= 3
           THEN now() ELSE capability_checked_at END,
         capability_invalidated_at = CASE WHEN capability_refresh_attempt_count >= 3
           THEN NULL ELSE capability_invalidated_at END,
         capability_refresh_next_attempt_at = now(),
         capability_refresh_lease_token = NULL, capability_refresh_lease_expires_at = NULL,
         capability_refresh_error = 'Recovered expired capability refresh lease', updated_at = now()
       WHERE (capability_refresh_lease_token IS NOT NULL AND capability_refresh_lease_expires_at < now())
         OR (capability_invalidated_at IS NOT NULL AND capability_refresh_lease_token IS NULL
           AND capability_refresh_attempt_count >= 3)`,
    );
    return result.rowCount ?? 0;
  }

  async listGroups(query: GroupQueryDto): Promise<{ data: GroupDto[]; total: number }> {
    const normalizedQuery = query.query?.trim();
    const searchPattern = normalizedQuery
      ? `%${normalizedQuery.replace(/[\\%_]/g, '\\$&')}%`
      : null;
    const activeFilter = query.isActive ?? true;
    const statuses = query.capabilityStatus ?? null;
    const freshness = query.capabilityFreshness ?? null;
    return this.database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const values = [
        query.sessionId,
        activeFilter,
        normalizedQuery || null,
        searchPattern,
        statuses,
        freshness,
      ];
      const predicate = `session_id = $1 AND is_active = $2
        AND ($4::text IS NULL
          OR id = $3
          OR name ILIKE $4 ESCAPE '\\'
          OR id ILIKE $4 ESCAPE '\\'
          OR description ILIKE $4 ESCAPE '\\')
        AND ($5::group_send_capability[] IS NULL OR send_capability = ANY($5))
        AND ($6::text[] IS NULL
          OR ('CURRENT' = ANY($6) AND capability_invalidated_at IS NULL)
          OR ('STALE' = ANY($6) AND capability_invalidated_at IS NOT NULL))`;
      const rows = await client.query<GroupRow>(
        `SELECT session_id, id, name, description, owner_id, linked_parent_id,
           participants_count, is_admin, is_read_only, is_announce, settings_locked, is_active,
           details_synced_at, synced_at, send_capability, send_capability_reason,
           capability_checked_at, capability_invalidated_at, capability_revision,
           capability_refresh_attempt_count, capability_refresh_lease_token,
           capability_refresh_lease_expires_at
         FROM gateway_groups
         WHERE ${predicate}
         ORDER BY name ASC, id ASC
         LIMIT $7 OFFSET $8`,
        [...values, query.limit, query.offset],
      );
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM gateway_groups WHERE ${predicate}`,
        values,
      );
      return { data: rows.rows.map(mapGroup), total: Number(count.rows[0]?.count ?? 0) };
    });
  }

  async findGroup(sessionId: string, groupId: string): Promise<GroupDto | null> {
    const result = await this.database.query<GroupRow>(
      'SELECT * FROM gateway_groups WHERE session_id = $1 AND id = $2 AND is_active = true', [sessionId, groupId]);
    return result.rows[0] ? mapGroup(result.rows[0]) : null;
  }

  async listMembers(
    sessionId: string,
    groupId: string,
    limit: number,
    offset: number,
    query?: string,
  ): Promise<{ data: GroupMemberDto[]; total: number }> {
    const normalizedQuery = query?.trim();
    const searchPattern = normalizedQuery
      ? `%${normalizedQuery.replace(/[\\%_]/g, '\\$&')}%`
      : null;
    return this.database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const rows = await client.query<MemberRow>(
        `SELECT participant_id, phone_number, display_name, is_admin, is_super_admin
         FROM group_members
         WHERE session_id = $1 AND group_id = $2
           AND ($5::text IS NULL
             OR display_name ILIKE $5 ESCAPE '\\'
             OR phone_number ILIKE $5 ESCAPE '\\'
             OR participant_id ILIKE $5 ESCAPE '\\')
         ORDER BY is_super_admin DESC, is_admin DESC,
           lower(coalesce(display_name, phone_number)) ASC, participant_id ASC
         LIMIT $3 OFFSET $4`,
        [sessionId, groupId, limit, offset, searchPattern],
      );
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM group_members
         WHERE session_id = $1 AND group_id = $2
           AND ($3::text IS NULL
             OR display_name ILIKE $3 ESCAPE '\\'
             OR phone_number ILIKE $3 ESCAPE '\\'
             OR participant_id ILIKE $3 ESCAPE '\\')`,
        [sessionId, groupId, searchPattern],
      );
      return { data: rows.rows.map(mapMember), total: Number(count.rows[0]?.count ?? 0) };
    });
  }

  async createSyncRun(sessionId: string): Promise<SyncRunDto> {
    const result = await this.database.query<SyncRunRow>(
      `INSERT INTO sync_runs (session_id, sync_type) VALUES ($1, 'FULL') RETURNING *`, [sessionId]);
    return mapSyncRun(result.rows[0]!);
  }

  async findSyncRunProgress(id: string, sessionId: string): Promise<{
    groupIds: Set<string>;
    groups: number;
    members: number;
  }> {
    const result = await this.database.query<{ id: string; members: string }>(
      `SELECT groups.id, count(members.participant_id)::text AS members
       FROM sync_runs runs
       JOIN gateway_groups groups ON groups.session_id = runs.session_id AND groups.is_active = true
       LEFT JOIN group_members members
         ON members.session_id = groups.session_id AND members.group_id = groups.id
       WHERE runs.id = $1 AND runs.session_id = $2 AND runs.started_at IS NOT NULL
         AND groups.details_synced_at >= runs.started_at
       GROUP BY groups.id`,
      [id, sessionId],
    );
    return {
      groupIds: new Set(result.rows.map(row => row.id)),
      groups: result.rows.length,
      members: result.rows.reduce((total, row) => total + Number(row.members), 0),
    };
  }

  async findSyncRun(id: string): Promise<SyncRunDto | null> {
    const result = await this.database.query<SyncRunRow>('SELECT * FROM sync_runs WHERE id = $1', [id]);
    return result.rows[0] ? mapSyncRun(result.rows[0]) : null;
  }

  async listPendingSyncRuns(limit: number): Promise<SyncRunDto[]> {
    const result = await this.database.query<SyncRunRow>(
      `SELECT * FROM sync_runs WHERE status = 'PENDING' AND attempt_count < 3 AND next_attempt_at <= now()
       ORDER BY next_attempt_at, requested_at LIMIT $1`, [limit],
    );
    return result.rows.map(mapSyncRun);
  }

  async recoverExpiredSyncRuns(): Promise<number> {
    const result = await this.database.query(
      `UPDATE sync_runs SET
         status = CASE WHEN attempt_count >= 3 THEN 'FAILED'::gateway_sync_status
           ELSE 'PENDING'::gateway_sync_status END,
         sync_epoch = CASE WHEN attempt_count >= 3 THEN sync_epoch ELSE NULL END,
         next_attempt_at = CASE WHEN attempt_count >= 3 THEN next_attempt_at ELSE now() END,
         lease_token = NULL, lease_expires_at = NULL,
         error = 'Recovered expired sync lease',
         completed_at = CASE WHEN attempt_count >= 3 THEN now() ELSE NULL END,
         updated_at = now()
       WHERE status = 'RUNNING' AND lease_expires_at < now()`,
    );
    return result.rowCount ?? 0;
  }

  async claimSyncRun(id: string): Promise<ClaimedSyncRun | null> {
    return this.database.transaction(async client => {
      const candidate = await client.query<{ session_id: string }>(
        'SELECT session_id FROM sync_runs WHERE id = $1',
        [id],
      );
      const sessionId = candidate.rows[0]?.session_id;
      if (!sessionId) return null;
      await client.query(
        `INSERT INTO gateway_sync_fences (session_id) VALUES ($1)
         ON CONFLICT (session_id) DO NOTHING`,
        [sessionId],
      );
      const fence = await client.query<{ current_epoch: string }>(
        'SELECT current_epoch FROM gateway_sync_fences WHERE session_id = $1 FOR UPDATE',
        [sessionId],
      );
      const syncEpoch = (BigInt(fence.rows[0]!.current_epoch) + 1n).toString();
      const result = await client.query<{
        lease_token: string;
        attempt_count: number;
      }>(
        `UPDATE sync_runs target SET status = 'RUNNING', attempt_count = attempt_count + 1,
           sync_epoch = $2::bigint, lease_token = gen_random_uuid(),
           lease_expires_at = now() + interval '2 minutes',
           groups_synced = 0, members_synced = 0, error = NULL,
           started_at = COALESCE(started_at, now()), completed_at = NULL, updated_at = now()
         WHERE id = $1 AND status = 'PENDING' AND attempt_count < 3 AND next_attempt_at <= now()
           AND NOT EXISTS (
             SELECT 1 FROM sync_runs active
             WHERE active.session_id = target.session_id AND active.status = 'RUNNING'
           )
         RETURNING lease_token, attempt_count`,
        [id, syncEpoch],
      );
      const row = result.rows[0];
      if (!row) return null;
      await client.query(
        'UPDATE gateway_sync_fences SET current_epoch = $2::bigint, updated_at = now() WHERE session_id = $1',
        [sessionId, syncEpoch],
      );
      return { sessionId, leaseToken: row.lease_token, attemptNumber: row.attempt_count, syncEpoch };
    });
  }

  async renewSyncLease(id: string, leaseToken: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE sync_runs SET lease_expires_at = now() + interval '2 minutes', updated_at = now()
       WHERE id = $1 AND status = 'RUNNING' AND lease_token = $2 AND lease_expires_at > now()`,
      [id, leaseToken],
    );
    return result.rowCount === 1;
  }

  async completeSyncRun(id: string, leaseToken: string, groups: number, members: number): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE sync_runs SET status = 'COMPLETED', groups_synced = $3, members_synced = $4,
         error = NULL, lease_token = NULL, lease_expires_at = NULL,
         completed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'RUNNING' AND lease_token = $2 AND lease_expires_at > now()`,
      [id, leaseToken, groups, members],
    );
    return result.rowCount === 1;
  }

  async failSyncRunAttempt(
    id: string,
    leaseToken: string,
    groups: number,
    members: number,
    error: string,
  ): Promise<SyncAttemptResult> {
    const result = await this.database.query<{ status: 'PENDING' | 'FAILED' }>(
      `UPDATE sync_runs SET
         status = CASE WHEN attempt_count >= 3 THEN 'FAILED'::gateway_sync_status
           ELSE 'PENDING'::gateway_sync_status END,
         sync_epoch = CASE WHEN attempt_count >= 3 THEN sync_epoch ELSE NULL END,
         groups_synced = $3, members_synced = $4, error = $5,
         next_attempt_at = CASE WHEN attempt_count >= 3 THEN next_attempt_at
           ELSE now() + LEAST(300, 5 * power(2, attempt_count - 1)) * interval '1 second' END,
         lease_token = NULL, lease_expires_at = NULL,
         completed_at = CASE WHEN attempt_count >= 3 THEN now() ELSE NULL END,
         updated_at = now()
       WHERE id = $1 AND status = 'RUNNING' AND lease_token = $2 AND lease_expires_at > now()
       RETURNING status`,
      [id, leaseToken, groups, members, error],
    );
    return result.rows[0]?.status ?? 'LOST_OWNERSHIP';
  }

  private async assertSyncWriteOwnership(
    client: PoolClient,
    sessionId: string,
    fence: SyncWriteFence,
  ): Promise<void> {
    const ownership = await client.query(
      `SELECT 1 FROM gateway_sync_fences
       WHERE session_id = $1 AND current_epoch = $2::bigint
       FOR SHARE`,
      [sessionId, fence.syncEpoch],
    );
    if (ownership.rowCount !== 1) throw new Error('Gateway sync attempt lost write ownership');
    const run = await client.query(
      `SELECT 1 FROM sync_runs
       WHERE id = $1 AND session_id = $2 AND status = 'RUNNING' AND sync_epoch = $4::bigint
         AND lease_token = $3 AND lease_expires_at > now()
       FOR SHARE`,
      [fence.syncRunId, sessionId, fence.leaseToken, fence.syncEpoch],
    );
    if (run.rowCount !== 1) throw new Error('Gateway sync attempt lost write ownership');
  }
}
