import type { GroupDto, GroupMemberDto } from '../../contracts/groups/group.dto';
import type { GroupQueryDto } from '../../contracts/groups/group-query.dto';
import { DatabaseService } from '../../core/database/database.service';
import type { GroupSendCapabilityStatus } from './group-capability';

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
}

interface MemberRow {
  participant_id: string;
  phone_number: string;
  display_name: string | null;
  identity_type: 'LID' | 'PHONE_JID' | 'OTHER_JID' | null;
  resolved_phone_number: string | null;
  display_name_source:
    | 'OPENWA_CONTACT_NAME'
    | 'GROUP_PARTICIPANT_NAME'
    | 'OPENWA_PUSH_NAME'
    | 'RESOLVED_ALIAS_PUSH_NAME'
    | null;
  projection_revision: string;
  is_admin: boolean;
  is_super_admin: boolean;
}

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
  identityType: row.identity_type,
  resolvedPhoneNumber: row.resolved_phone_number,
  displayNameSource: row.display_name_source,
  projectionRevision: Number(row.projection_revision),
  isAdmin: row.is_admin,
  isSuperAdmin: row.is_super_admin,
});

export class GatewayGroupQueryRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly readContactProjection = false,
  ) {}

  async list(query: GroupQueryDto): Promise<{ data: GroupDto[]; total: number }> {
    const normalizedQuery = query.query?.trim();
    const searchPattern = normalizedQuery
      ? `%${normalizedQuery.replace(/[\\%_]/g, '\\$&')}%`
      : null;
    const activeFilter = query.isActive ?? true;
    const statuses = query.capabilityStatus ?? null;
    const freshness = query.capabilityFreshness ?? null;
    return this.database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const values = [
        query.sessionId,
        activeFilter,
        normalizedQuery || null,
        searchPattern,
        statuses,
        freshness,
        query.minParticipants ?? null,
        query.maxParticipants ?? null,
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
          OR ('STALE' = ANY($6) AND capability_invalidated_at IS NOT NULL))
        AND ($7::integer IS NULL OR participants_count >= $7::integer)
        AND ($8::integer IS NULL OR participants_count <= $8::integer)`;
      const rows = await client.query<GroupRow>(
        `SELECT session_id, id, name, description, owner_id, linked_parent_id,
           participants_count, is_admin, is_read_only, is_announce, settings_locked, is_active,
           details_synced_at, synced_at, send_capability, send_capability_reason,
           capability_checked_at, capability_invalidated_at, capability_revision
         FROM gateway_groups
         WHERE ${predicate}
         ORDER BY name ASC, id ASC
         LIMIT $9 OFFSET $10`,
        [...values, query.limit, query.offset],
      );
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM gateway_groups WHERE ${predicate}`,
        values,
      );
      return { data: rows.rows.map(mapGroup), total: Number(count.rows[0]?.count ?? 0) };
    });
  }

  async find(sessionId: string, groupId: string, activeOnly = true): Promise<GroupDto | null> {
    const result = await this.database.query<GroupRow>(
      `SELECT * FROM gateway_groups WHERE session_id = $1 AND id = $2${activeOnly ? ' AND is_active = true' : ''}`,
      [sessionId, groupId],
    );
    return result.rows[0] ? mapGroup(result.rows[0]) : null;
  }

  async listMembers(
    sessionId: string,
    groupId: string,
    limit: number,
    offset: number,
    query?: string,
  ): Promise<{ data: GroupMemberDto[]; total: number; datasetRevision: number }> {
    const normalizedQuery = query?.trim();
    const searchPattern = normalizedQuery
      ? `%${normalizedQuery.replace(/[\\%_]/g, '\\$&')}%`
      : null;
    return this.database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const rows = await client.query<MemberRow>(
        `SELECT participant_id, phone_number,
           CASE WHEN $6::boolean AND shadow_projection_revision > 0
             THEN shadow_display_name ELSE display_name END AS display_name,
           identity_type,
           CASE WHEN $6::boolean AND shadow_projection_revision > 0
             THEN shadow_resolved_phone_number ELSE resolved_phone_number
           END AS resolved_phone_number,
           CASE WHEN $6::boolean AND shadow_projection_revision > 0
             THEN shadow_display_name_source ELSE display_name_source
           END AS display_name_source,
           CASE WHEN $6::boolean AND shadow_projection_revision > 0
             THEN shadow_projection_revision ELSE 0 END::text AS projection_revision,
           is_admin, is_super_admin
         FROM group_members
         WHERE session_id = $1 AND group_id = $2
           AND ($5::text IS NULL
             OR (CASE WHEN $6::boolean AND shadow_projection_revision > 0
                   THEN shadow_display_name ELSE display_name END) ILIKE $5 ESCAPE '\\'
             OR (CASE WHEN $6::boolean AND shadow_projection_revision > 0
                   THEN shadow_resolved_phone_number ELSE resolved_phone_number END) ILIKE $5 ESCAPE '\\'
             OR phone_number ILIKE $5 ESCAPE '\\'
             OR participant_id ILIKE $5 ESCAPE '\\')
         ORDER BY is_super_admin DESC, is_admin DESC,
           CASE WHEN $6::boolean AND shadow_projection_revision > 0
             THEN shadow_sort_value
             ELSE lower(coalesce(display_name, phone_number)) END ASC,
           participant_id ASC
         LIMIT $3 OFFSET $4`,
        [sessionId, groupId, limit, offset, searchPattern, this.readContactProjection],
      );
      const count = await client.query<{ count: string; dataset_revision: string }>(
        `SELECT count(*)::text AS count,
           CASE WHEN $4::boolean THEN COALESCE((
             SELECT groups.member_dataset_revision
             FROM gateway_groups groups
             WHERE groups.session_id = $1 AND groups.id = $2
           ), 0) ELSE 0 END::text AS dataset_revision
         FROM group_members
         WHERE session_id = $1 AND group_id = $2
           AND ($3::text IS NULL
             OR (CASE WHEN $4::boolean AND shadow_projection_revision > 0
                   THEN shadow_display_name ELSE display_name END) ILIKE $3 ESCAPE '\\'
             OR (CASE WHEN $4::boolean AND shadow_projection_revision > 0
                   THEN shadow_resolved_phone_number ELSE resolved_phone_number END) ILIKE $3 ESCAPE '\\'
             OR phone_number ILIKE $3 ESCAPE '\\'
             OR participant_id ILIKE $3 ESCAPE '\\')`,
        [sessionId, groupId, searchPattern, this.readContactProjection],
      );
      return {
        data: rows.rows.map(mapMember),
        total: Number(count.rows[0]?.count ?? 0),
        datasetRevision: Number(count.rows[0]?.dataset_revision ?? 0),
      };
    });
  }
}
