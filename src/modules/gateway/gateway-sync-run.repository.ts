import type { SyncRunDto, SyncRunPhase, SyncRunStatus } from '../../contracts/sessions/sync-run.dto';
import { GatewaySyncMode } from '../../contracts/sessions/sync-request.dto';
import { DatabaseService } from '../../core/database/database.service';
import { GatewaySyncModeConflictError } from './gateway-sync.types';

interface SyncRunRow {
  id: string;
  session_id: string;
  sync_type: GatewaySyncMode;
  status: SyncRunStatus;
  phase: SyncRunPhase;
  groups_synced: number;
  groups_discovered: number;
  groups_scheduled: number;
  groups_failed: number;
  groups_skipped: number;
  groups_pending?: number;
  groups_running?: number;
  groups_retrying?: number;
  members_synced: number;
  item_next_attempt_at?: Date | null;
  next_attempt_at: Date;
  cooldown_until?: Date | null;
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

export type SyncAttemptResult = 'PENDING' | 'FAILED' | 'LOST_OWNERSHIP';

const mapSyncRun = (row: SyncRunRow): SyncRunDto => ({
  id: row.id,
  sessionId: row.session_id,
  syncType: row.sync_type,
  phase: row.phase,
  status: row.status,
  groupsSynced: row.groups_synced,
  groupsDiscovered: row.groups_discovered,
  groupsScheduled: row.groups_scheduled,
  groupsFailed: row.groups_failed,
  groupsSkipped: row.groups_skipped,
  groupsPending: row.groups_pending ?? 0,
  groupsRunning: row.groups_running ?? 0,
  groupsRetrying: row.groups_retrying ?? 0,
  membersSynced: row.members_synced,
  nextAttemptAt: row.item_next_attempt_at ?? (row.status === 'PENDING' ? row.next_attempt_at : null),
  cooldownUntil: row.cooldown_until ?? null,
  error: row.error,
  requestedAt: row.requested_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
});

export class GatewaySyncRunRepository {
  constructor(private readonly database: DatabaseService) {}

  async create(sessionId: string, mode: GatewaySyncMode = GatewaySyncMode.FULL): Promise<SyncRunDto> {
    const id = await this.database.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-sync:${sessionId}`]);
      const active = await client.query<SyncRunRow>(
        `SELECT * FROM sync_runs WHERE session_id = $1 AND status IN ('PENDING','RUNNING')
         ORDER BY requested_at LIMIT 1`,
        [sessionId],
      );
      if (active.rows[0]) {
        const existing = mapSyncRun(active.rows[0]);
        if (existing.syncType !== mode) {
          throw new GatewaySyncModeConflictError(existing.id, existing.syncType);
        }
        return existing.id;
      }
      const result = await client.query<{ id: string }>(
        `INSERT INTO sync_runs (session_id, sync_type) VALUES ($1, $2) RETURNING id`, [sessionId, mode]);
      return result.rows[0]!.id;
    });
    const run = await this.find(id);
    if (!run) throw new Error('Created sync run was not found');
    return run;
  }

  async findProgress(id: string, sessionId: string): Promise<{
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

  async find(id: string): Promise<SyncRunDto | null> {
    const result = await this.database.query<SyncRunRow>(
      `SELECT runs.*,
         count(items.id) FILTER (WHERE items.status = 'PENDING')::integer AS groups_pending,
         count(items.id) FILTER (WHERE items.status = 'RUNNING')::integer AS groups_running,
         count(items.id) FILTER (WHERE items.status = 'RETRY')::integer AS groups_retrying,
         min(items.next_attempt_at) FILTER (WHERE items.status IN ('PENDING','RETRY')) AS item_next_attempt_at,
         CASE WHEN runs.status IN ('PENDING','RUNNING') THEN limits.cooldown_until END AS cooldown_until
       FROM sync_runs runs
       LEFT JOIN gateway_sync_items items ON items.sync_run_id = runs.id
       LEFT JOIN gateway_sync_rate_limits limits ON limits.session_id = runs.session_id
       WHERE runs.id = $1
       GROUP BY runs.id, limits.cooldown_until`,
      [id],
    );
    return result.rows[0] ? mapSyncRun(result.rows[0]) : null;
  }

  async listPending(limit: number): Promise<SyncRunDto[]> {
    const result = await this.database.query<SyncRunRow>(
      `SELECT * FROM sync_runs WHERE status = 'PENDING' AND attempt_count < 3 AND next_attempt_at <= now()
       ORDER BY next_attempt_at, requested_at LIMIT $1`, [limit],
    );
    return result.rows.map(mapSyncRun);
  }

  async recoverExpired(): Promise<number> {
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

  async claim(id: string): Promise<ClaimedSyncRun | null> {
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
      const result = await client.query<{ lease_token: string; attempt_count: number }>(
        `UPDATE sync_runs target SET status = 'RUNNING', attempt_count = attempt_count + 1,
           sync_epoch = $2::bigint, lease_token = gen_random_uuid(),
           lease_expires_at = now() + interval '2 minutes',
           phase = 'DISCOVERING', groups_synced = 0, groups_discovered = 0,
           groups_scheduled = 0, groups_failed = 0, groups_skipped = 0,
           members_synced = 0, error = NULL,
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

  async renewLease(id: string, leaseToken: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE sync_runs SET lease_expires_at = now() + interval '2 minutes', updated_at = now()
       WHERE id = $1 AND status = 'RUNNING' AND lease_token = $2 AND lease_expires_at > now()`,
      [id, leaseToken],
    );
    return result.rowCount === 1;
  }

  async complete(id: string, leaseToken: string, groups: number, members: number): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE sync_runs SET status = 'COMPLETED', groups_synced = $3, members_synced = $4,
         error = NULL, lease_token = NULL, lease_expires_at = NULL,
         completed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'RUNNING' AND lease_token = $2 AND lease_expires_at > now()`,
      [id, leaseToken, groups, members],
    );
    return result.rowCount === 1;
  }

  async failAttempt(
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
}
