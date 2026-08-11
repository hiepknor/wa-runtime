import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { GroupDto, GroupMemberDto } from '../contracts/groups/group.dto';
import type { SessionDto } from '../contracts/sessions/session.dto';
import type { SyncRunDto, SyncRunStatus } from '../contracts/sessions/sync-run.dto';
import { DatabaseService } from '../database/database.service';
import type { OpenWAGroup, OpenWAGroupSummary, OpenWASession } from '../openwa/openwa.client';

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

  async upsertSession(session: OpenWASession): Promise<SessionDto> {
    const result = await this.database.query<SessionRow>(
      `INSERT INTO gateway_sessions
         (id, name, status, phone, push_name, connected_at, last_active_at, engine_loaded,
          last_error, gateway_created_at, gateway_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, status = EXCLUDED.status, phone = EXCLUDED.phone,
         push_name = EXCLUDED.push_name, connected_at = EXCLUDED.connected_at,
         last_active_at = EXCLUDED.last_active_at, engine_loaded = EXCLUDED.engine_loaded,
         last_error = EXCLUDED.last_error, gateway_updated_at = EXCLUDED.gateway_updated_at,
         synced_at = now(), updated_at = now()
       RETURNING *`,
      [session.id, session.name, session.status, session.phone ?? null, session.pushName ?? null,
        session.connectedAt ?? null, session.lastActive ?? null, session.engineLoaded,
        session.lastError ?? null, session.createdAt, session.updatedAt],
    );
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

  async replaceGroupSummaries(sessionId: string, groups: OpenWAGroupSummary[]): Promise<void> {
    await this.database.transaction(async client => {
      await client.query('UPDATE gateway_groups SET is_active = false, updated_at = now() WHERE session_id = $1', [sessionId]);
      for (const group of groups) await this.upsertGroupSummary(client, sessionId, group);
    });
  }

  private async upsertGroupSummary(client: PoolClient, sessionId: string, group: OpenWAGroupSummary): Promise<void> {
    await client.query(
      `INSERT INTO gateway_groups
         (session_id, id, name, participants_count, is_admin, linked_parent_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (session_id, id) DO UPDATE SET
         name = EXCLUDED.name,
         participants_count = COALESCE(EXCLUDED.participants_count, gateway_groups.participants_count),
         is_admin = COALESCE(EXCLUDED.is_admin, gateway_groups.is_admin),
         linked_parent_id = EXCLUDED.linked_parent_id,
         is_active = true, synced_at = now(), updated_at = now()`,
      [sessionId, group.id, group.name, group.participantsCount ?? null, group.isAdmin ?? null, group.linkedParentJID ?? null],
    );
  }

  async upsertGroupDetails(sessionId: string, group: OpenWAGroup): Promise<number> {
    return this.database.transaction(async client => {
      await client.query(
        `INSERT INTO gateway_groups
           (session_id, id, name, description, owner_id, linked_parent_id, participants_count,
            is_admin, is_read_only, is_announce, settings_locked, ephemeral_seconds,
            member_add_mode, gateway_created_at, details_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 CASE WHEN $14::bigint IS NULL THEN NULL ELSE to_timestamp($14::bigint) END, now())
         ON CONFLICT (session_id, id) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description, owner_id = EXCLUDED.owner_id,
           linked_parent_id = EXCLUDED.linked_parent_id, participants_count = EXCLUDED.participants_count,
           is_admin = COALESCE(EXCLUDED.is_admin, gateway_groups.is_admin),
           is_read_only = EXCLUDED.is_read_only, is_announce = EXCLUDED.is_announce,
           settings_locked = EXCLUDED.settings_locked, ephemeral_seconds = EXCLUDED.ephemeral_seconds,
           member_add_mode = EXCLUDED.member_add_mode, gateway_created_at = EXCLUDED.gateway_created_at,
           is_active = true, details_synced_at = now(), synced_at = now(), updated_at = now()`,
        [sessionId, group.id, group.name, group.description ?? null, group.owner ?? null,
          group.linkedParentJID ?? null, group.participants.length, group.isAdmin ?? null,
          group.isReadOnly ?? null, group.announce ?? group.isAnnounce ?? null, group.locked ?? null,
          group.ephemeralSeconds ?? null, group.memberAddMode ?? null, group.createdAt ?? null],
      );
      await client.query('DELETE FROM group_members WHERE session_id = $1 AND group_id = $2', [sessionId, group.id]);
      for (const participant of group.participants) {
        await client.query(
          `INSERT INTO group_members
             (session_id, group_id, participant_id, phone_number, display_name, is_admin, is_super_admin)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [sessionId, group.id, participant.id, participant.number, participant.name ?? null,
            participant.isAdmin, participant.isSuperAdmin],
        );
      }
      return group.participants.length;
    });
  }

  async listGroups(sessionId: string, limit: number, offset: number): Promise<{ data: GroupDto[]; total: number }> {
    const [rows, count] = await Promise.all([
      this.database.query<GroupRow>(
        `SELECT * FROM gateway_groups WHERE session_id = $1 AND is_active = true
         ORDER BY name, id LIMIT $2 OFFSET $3`, [sessionId, limit, offset]),
      this.database.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM gateway_groups WHERE session_id = $1 AND is_active = true', [sessionId]),
    ]);
    return { data: rows.rows.map(mapGroup), total: Number(count.rows[0]?.count ?? 0) };
  }

  async findGroup(sessionId: string, groupId: string): Promise<GroupDto | null> {
    const result = await this.database.query<GroupRow>(
      'SELECT * FROM gateway_groups WHERE session_id = $1 AND id = $2 AND is_active = true', [sessionId, groupId]);
    return result.rows[0] ? mapGroup(result.rows[0]) : null;
  }

  async listMembers(sessionId: string, groupId: string, limit: number, offset: number): Promise<{ data: GroupMemberDto[]; total: number }> {
    const [rows, count] = await Promise.all([
      this.database.query<MemberRow>(
        `SELECT participant_id, phone_number, display_name, is_admin, is_super_admin
         FROM group_members WHERE session_id = $1 AND group_id = $2
         ORDER BY display_name NULLS LAST, participant_id LIMIT $3 OFFSET $4`, [sessionId, groupId, limit, offset]),
      this.database.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM group_members WHERE session_id = $1 AND group_id = $2', [sessionId, groupId]),
    ]);
    return { data: rows.rows.map(mapMember), total: Number(count.rows[0]?.count ?? 0) };
  }

  async createSyncRun(sessionId: string): Promise<SyncRunDto> {
    const result = await this.database.query<SyncRunRow>(
      `INSERT INTO sync_runs (session_id, sync_type) VALUES ($1, 'FULL') RETURNING *`, [sessionId]);
    return mapSyncRun(result.rows[0]!);
  }

  async findSyncRun(id: string): Promise<SyncRunDto | null> {
    const result = await this.database.query<SyncRunRow>('SELECT * FROM sync_runs WHERE id = $1', [id]);
    return result.rows[0] ? mapSyncRun(result.rows[0]) : null;
  }

  async listPendingSyncRuns(limit: number): Promise<SyncRunDto[]> {
    const result = await this.database.query<SyncRunRow>(
      `SELECT * FROM sync_runs WHERE status = 'PENDING' ORDER BY requested_at LIMIT $1`, [limit],
    );
    return result.rows.map(mapSyncRun);
  }

  async updateSyncRun(id: string, input: { status: SyncRunStatus; groups?: number; members?: number; error?: string }): Promise<void> {
    await this.database.query(
      `UPDATE sync_runs SET status = $2::gateway_sync_status, groups_synced = COALESCE($3, groups_synced),
         members_synced = COALESCE($4, members_synced), error = $5,
         started_at = CASE WHEN $2::gateway_sync_status = 'RUNNING' THEN now() ELSE started_at END,
         completed_at = CASE WHEN $2::gateway_sync_status IN ('COMPLETED','FAILED') THEN now() ELSE completed_at END
       WHERE id = $1`, [id, input.status, input.groups ?? null, input.members ?? null, input.error ?? null]);
  }
}
