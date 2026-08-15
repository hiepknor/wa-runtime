import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { DatabaseService } from '../../core/database/database.service';
import { pendingGroupName, type OpenWAGroupSummary } from '../../integrations/openwa/openwa.client';
import type { GatewaySyncMode } from '../../contracts/sessions/sync-request.dto';
import type { SyncWriteFence } from './gateway.repository';
import type {
  ClaimedGatewaySyncItem,
  GatewaySyncFailurePolicy,
  GatewaySyncItemDispatch,
} from './gateway-sync-item.types';
import { GatewaySyncRateLimitRepository } from './gateway-sync-rate-limit.repository';

const summaryFingerprint = (group: OpenWAGroupSummary): string => createHash('sha256').update(JSON.stringify({
  id: group.id,
  name: group.name,
  participantsCount: group.participantsCount ?? null,
  isAdmin: group.isAdmin ?? null,
  linkedParentJID: group.linkedParentJID ?? null,
})).digest('hex');

const snapshotFingerprint = (groups: OpenWAGroupSummary[]): string => createHash('sha256')
  .update(JSON.stringify(groups.map(group => group.id).sort()))
  .digest('hex');

@Injectable()
export class GatewaySyncItemRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly rateLimits: GatewaySyncRateLimitRepository = new GatewaySyncRateLimitRepository(database),
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async publishDiscovery(
    fence: SyncWriteFence,
    sessionId: string,
    mode: GatewaySyncMode,
    groups: OpenWAGroupSummary[],
  ): Promise<{ discovered: number; scheduled: number; completed: boolean; deferred: boolean }> {
    return this.database.transaction(async client => {
      await this.assertDiscoveryOwnership(client, fence, sessionId);
      const current = await client.query<{
        id: string;
        reconciled_summary_fingerprint: string | null;
        details_synced_at: Date | null;
        capability_invalidated_at: Date | null;
      }>(
        `SELECT id, reconciled_summary_fingerprint, details_synced_at, capability_invalidated_at
         FROM gateway_groups WHERE session_id = $1 FOR UPDATE`,
        [sessionId],
      );
      const existing = new Map(current.rows.map(row => [row.id, row]));
      const snapshot = snapshotFingerprint(groups);
      const sessionState = await client.query<{
        group_snapshot_count: number | null;
        suspicious_group_snapshot_fingerprint: string | null;
        suspicious_group_snapshot_count: number | null;
        suspicious_group_snapshot_confirmations: number;
      }>(
        `SELECT group_snapshot_count, suspicious_group_snapshot_fingerprint,
           suspicious_group_snapshot_count, suspicious_group_snapshot_confirmations
         FROM gateway_sessions WHERE id = $1 FOR UPDATE`,
        [sessionId],
      );
      const state = sessionState.rows[0];
      const baseline = state?.group_snapshot_count ?? existing.size;
      const suspicious = baseline >= this.config.GATEWAY_SYNC_SNAPSHOT_MIN_BASELINE
        && groups.length < baseline * this.config.GATEWAY_SYNC_SNAPSHOT_DROP_RATIO;
      const matchingConfirmation = suspicious
        && state?.suspicious_group_snapshot_fingerprint === snapshot
        && state.suspicious_group_snapshot_count === groups.length;
      const confirmations = matchingConfirmation
        ? state.suspicious_group_snapshot_confirmations + 1
        : 1;
      if (suspicious && confirmations < this.config.GATEWAY_SYNC_SNAPSHOT_CONFIRMATIONS) {
        await client.query(
          `UPDATE gateway_sessions SET suspicious_group_snapshot_fingerprint = $2,
             suspicious_group_snapshot_count = $3, suspicious_group_snapshot_confirmations = $4,
             updated_at = now() WHERE id = $1`,
          [sessionId, snapshot, groups.length, confirmations],
        );
        await client.query(
          `UPDATE sync_runs SET status = 'PENDING', sync_epoch = NULL,
             attempt_count = GREATEST(attempt_count - 1, 0),
             next_attempt_at = now() + interval '5 seconds', lease_token = NULL,
             lease_expires_at = NULL, error = 'SUSPICIOUS_GROUP_SNAPSHOT', updated_at = now()
           WHERE id = $1 AND lease_token = $2`,
          [fence.syncRunId, fence.leaseToken],
        );
        return { discovered: groups.length, scheduled: 0, completed: false, deferred: true };
      }
      await this.replaceSummaries(client, sessionId, groups);

      const staleBefore = new Date(Date.now() - this.config.GATEWAY_GROUP_DETAILS_STALE_AFTER_HOURS * 3_600_000);
      const selected = groups.flatMap((group, ordinal) => {
        const before = existing.get(group.id);
        const fingerprint = summaryFingerprint(group);
        let reason: string | undefined;
        if (mode === 'FULL') reason = 'FULL';
        else if (!before?.details_synced_at) reason = 'MISSING_DETAILS';
        else if (before.capability_invalidated_at) reason = 'CAPABILITY_INVALIDATED';
        else if (before.reconciled_summary_fingerprint !== fingerprint) reason = 'SUMMARY_NOT_RECONCILED';
        else if (before.details_synced_at < staleBefore) reason = 'DETAILS_STALE';
        return reason ? [{ group, ordinal, reason, fingerprint }] : [];
      });

      if (selected.length > 0) {
        await client.query(
          `INSERT INTO gateway_sync_items
             (sync_run_id, session_id, group_id, ordinal, reason, observed_summary_fingerprint)
           SELECT $1, $2, item.group_id, item.ordinal, item.reason, item.fingerprint
           FROM jsonb_to_recordset($3::jsonb)
             AS item(group_id text, ordinal integer, reason text, fingerprint text)
           ON CONFLICT (sync_run_id, group_id) DO NOTHING`,
          [fence.syncRunId, sessionId, JSON.stringify(selected.map(item => ({
            group_id: item.group.id, ordinal: item.ordinal, reason: item.reason,
            fingerprint: item.fingerprint,
          })))],
        );
      }
      if (groups.length > 0) {
        await client.query(
          `UPDATE gateway_groups groups SET summary_fingerprint = source.fingerprint
           FROM jsonb_to_recordset($2::jsonb) AS source(id text, fingerprint text)
           WHERE groups.session_id = $1 AND groups.id = source.id`,
          [sessionId, JSON.stringify(groups.map(group => ({ id: group.id, fingerprint: summaryFingerprint(group) })))],
        );
      }

      const completed = selected.length === 0;
      await client.query(
        `UPDATE gateway_sessions SET group_snapshot_count = $2,
           suspicious_group_snapshot_fingerprint = NULL, suspicious_group_snapshot_count = NULL,
           suspicious_group_snapshot_confirmations = 0, updated_at = now() WHERE id = $1`,
        [sessionId, groups.length],
      );
      await client.query(
        `UPDATE sync_runs SET phase = $3, groups_discovered = $4, groups_scheduled = $5,
           status = CASE WHEN $6 THEN 'COMPLETED'::gateway_sync_status ELSE status END,
           completed_at = CASE WHEN $6 THEN now() ELSE NULL END,
           lease_token = NULL, lease_expires_at = NULL, error = NULL, updated_at = now()
         WHERE id = $1 AND lease_token = $2`,
        [fence.syncRunId, fence.leaseToken, completed ? 'COMPLETED' : 'RECONCILING',
          groups.length, selected.length, completed],
      );
      return { discovered: groups.length, scheduled: selected.length, completed, deferred: false };
    });
  }

  async listDispatchable(limit: number): Promise<GatewaySyncItemDispatch[]> {
    const result = await this.database.query<{
      id: string; sync_run_id: string; session_id: string; group_id: string; available_at: Date;
    }>(
      `WITH candidates AS (
         SELECT items.id, items.sync_run_id, items.session_id, items.group_id,
           items.ordinal,
           GREATEST(items.next_attempt_at,
             COALESCE(limits.next_request_at, '-infinity'::timestamptz),
             COALESCE(limits.cooldown_until, '-infinity'::timestamptz)) AS available_at
         FROM gateway_sync_items items
         JOIN sync_runs runs ON runs.id = items.sync_run_id AND runs.status = 'RUNNING'
         LEFT JOIN gateway_sync_rate_limits limits ON limits.session_id = items.session_id
         WHERE items.status IN ('PENDING', 'RETRY') AND items.attempt_count < $2
           AND (limits.active_lease_token IS NULL OR limits.active_lease_expires_at < now())
       ), ranked AS (
         SELECT id, sync_run_id, session_id, group_id, available_at, ordinal,
           row_number() OVER (
             PARTITION BY session_id ORDER BY available_at, ordinal
           ) AS session_rank
         FROM candidates
       )
       SELECT id, sync_run_id, session_id, group_id, available_at FROM ranked
       WHERE session_rank = 1 ORDER BY available_at, ordinal LIMIT $1`,
      [limit, this.config.GATEWAY_SYNC_ITEM_MAX_ATTEMPTS],
    );
    return result.rows.map(row => ({
      id: row.id, syncRunId: row.sync_run_id, sessionId: row.session_id, groupId: row.group_id,
      availableAt: row.available_at,
    }));
  }

  async reserveSessionRequest(sessionId: string): Promise<string | null> {
    return this.rateLimits.reserve(sessionId);
  }

  async recordSessionRequestOutcome(
    sessionId: string,
    leaseToken: string,
    success: boolean,
    ratePressure = false,
    reduceRate = false,
  ): Promise<void> {
    await this.rateLimits.record(sessionId, leaseToken, success ? undefined : {
      retryable: true, ratePressure, reduceRate, code: 'REQUEST_FAILED',
    });
  }

  async releaseSessionRequest(sessionId: string, leaseToken: string): Promise<void> {
    await this.rateLimits.releaseLease(sessionId, leaseToken);
  }

  async claim(id: string): Promise<ClaimedGatewaySyncItem | null> {
    return this.database.transaction(async client => {
      const candidate = await client.query<{
        sync_run_id: string; session_id: string; group_id: string; sync_epoch: string;
        observed_summary_fingerprint: string | null;
      }>(
        `SELECT items.sync_run_id, items.session_id, items.group_id, runs.sync_epoch,
           items.observed_summary_fingerprint
         FROM gateway_sync_items items JOIN sync_runs runs ON runs.id = items.sync_run_id
         WHERE items.id = $1 AND runs.status = 'RUNNING' FOR UPDATE OF items`,
        [id],
      );
      const row = candidate.rows[0];
      if (!row) return null;
      await this.rateLimits.ensure(client, row.session_id);
      const effectiveRate = await this.rateLimits.readyAndRate(client, row.session_id);
      if (effectiveRate === null) return null;
      const claimed = await client.query<{ lease_token: string; attempt_count: number }>(
        `UPDATE gateway_sync_items SET status = 'RUNNING', attempt_count = attempt_count + 1,
           lease_token = gen_random_uuid(), lease_expires_at = now() + interval '2 minutes',
           started_at = COALESCE(started_at, now()), error = NULL, updated_at = now()
         WHERE id = $1 AND status IN ('PENDING', 'RETRY') AND next_attempt_at <= now()
           AND attempt_count < $2
         RETURNING lease_token, attempt_count`,
        [id, this.config.GATEWAY_SYNC_ITEM_MAX_ATTEMPTS],
      );
      const claim = claimed.rows[0];
      if (!claim) return null;
      await this.rateLimits.acquire(client, row.session_id, claim.lease_token, effectiveRate);
      return {
        id, syncRunId: row.sync_run_id, sessionId: row.session_id, groupId: row.group_id,
        syncEpoch: row.sync_epoch, leaseToken: claim.lease_token, attemptNumber: claim.attempt_count,
        observedSummaryFingerprint: row.observed_summary_fingerprint,
      };
    });
  }

  async renewLease(id: string, leaseToken: string): Promise<boolean> {
    return this.database.transaction(async client => {
      const result = await client.query<{ session_id: string }>(
        `UPDATE gateway_sync_items SET lease_expires_at = now() + interval '2 minutes', updated_at = now()
         WHERE id = $1 AND status = 'RUNNING' AND lease_token = $2 AND lease_expires_at > now()
         RETURNING session_id`,
        [id, leaseToken],
      );
      const row = result.rows[0];
      if (!row || !await this.rateLimits.renew(client, row.session_id, leaseToken)) {
        throw new LostGatewaySyncLeaseError();
      }
      return true;
    }).catch(error => {
      if (error instanceof LostGatewaySyncLeaseError) return false;
      throw error;
    });
  }

  async complete(id: string, leaseToken: string, members: number): Promise<boolean> {
    return this.database.transaction(async client => {
      const result = await client.query<{ sync_run_id: string; session_id: string }>(
        `UPDATE gateway_sync_items SET status = 'COMPLETED', members_synced = $3,
           lease_token = NULL, lease_expires_at = NULL, completed_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'RUNNING' AND lease_token = $2 AND lease_expires_at > now()
         RETURNING sync_run_id, session_id`,
        [id, leaseToken, members],
      );
      const row = result.rows[0];
      if (!row) return false;
      await client.query(
        `UPDATE gateway_groups groups SET reconciled_summary_fingerprint =
             COALESCE(items.observed_summary_fingerprint, groups.reconciled_summary_fingerprint),
           updated_at = now()
         FROM gateway_sync_items items
         WHERE items.id = $1 AND groups.session_id = items.session_id AND groups.id = items.group_id`,
        [id],
      );
      await this.rateLimits.success(client, row.session_id, leaseToken);
      await this.refreshParent(client, row.sync_run_id);
      return true;
    });
  }

  async skip(id: string, leaseToken: string, error: string): Promise<boolean> {
    return this.database.transaction(async client => {
      const result = await client.query<{ sync_run_id: string; session_id: string }>(
        `UPDATE gateway_sync_items SET status = 'SKIPPED', error = $3,
           lease_token = NULL, lease_expires_at = NULL, completed_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'RUNNING' AND lease_token = $2 AND lease_expires_at > now()
         RETURNING sync_run_id, session_id`,
        [id, leaseToken, error],
      );
      const row = result.rows[0];
      if (!row) return false;
      await this.rateLimits.release(client, row.session_id, leaseToken);
      await this.refreshParent(client, row.sync_run_id);
      return true;
    });
  }

  async fail(
    id: string,
    leaseToken: string,
    error: string,
    policy: GatewaySyncFailurePolicy,
  ): Promise<'RETRY' | 'FAILED' | 'LOST_OWNERSHIP'> {
    return this.database.transaction(async client => {
      const owned = await client.query<{
        sync_run_id: string; session_id: string; attempt_count: number;
      }>(
        `SELECT sync_run_id, session_id, attempt_count FROM gateway_sync_items
         WHERE id = $1 AND status = 'RUNNING' AND lease_token = $2 AND lease_expires_at > now()
         FOR UPDATE`,
        [id, leaseToken],
      );
      const row = owned.rows[0];
      if (!row) return 'LOST_OWNERSHIP';
      const willRetry = policy.retryable && row.attempt_count < this.config.GATEWAY_SYNC_ITEM_MAX_ATTEMPTS;
      const delaySeconds = Math.min(300, 5 * 2 ** Math.max(0, row.attempt_count - 1))
        * (0.8 + Math.random() * 0.4);
      await client.query(
        `UPDATE gateway_sync_items SET status = $3::gateway_sync_item_status, error = $4,
           next_attempt_at = CASE WHEN $3 = 'RETRY' THEN now() + ($5 * interval '1 second') ELSE next_attempt_at END,
           lease_token = NULL, lease_expires_at = NULL,
           completed_at = CASE WHEN $3 = 'FAILED' THEN now() ELSE NULL END, updated_at = now()
         WHERE id = $1 AND lease_token = $2`,
        [id, leaseToken, willRetry ? 'RETRY' : 'FAILED', error, delaySeconds],
      );
      await this.rateLimits.failure(client, row.session_id, leaseToken, policy);
      await this.refreshParent(client, row.sync_run_id);
      return willRetry ? 'RETRY' : 'FAILED';
    });
  }

  async recoverExpired(): Promise<number> {
    return this.database.transaction(async client => {
      const result = await client.query<{ sync_run_id: string }>(
        `UPDATE gateway_sync_items SET
           status = CASE WHEN attempt_count >= $1 THEN 'FAILED'::gateway_sync_item_status
             ELSE 'RETRY'::gateway_sync_item_status END,
           next_attempt_at = now(), lease_token = NULL, lease_expires_at = NULL,
           error = 'Recovered expired group reconciliation lease',
           completed_at = CASE WHEN attempt_count >= $1 THEN now() ELSE NULL END, updated_at = now()
         WHERE status = 'RUNNING' AND lease_expires_at < now()
         RETURNING sync_run_id`,
        [this.config.GATEWAY_SYNC_ITEM_MAX_ATTEMPTS],
      );
      for (const syncRunId of new Set(result.rows.map(row => row.sync_run_id))) {
        await this.refreshParent(client, syncRunId);
      }
      await client.query(
        `UPDATE gateway_sync_rate_limits SET active_lease_token = NULL, active_lease_expires_at = NULL,
           updated_at = now() WHERE active_lease_expires_at < now()`,
      );
      return result.rowCount ?? 0;
    });
  }

  private async refreshParent(client: PoolClient, syncRunId: string): Promise<void> {
    await client.query(
      `WITH aggregate AS (
         SELECT count(*) FILTER (WHERE status = 'COMPLETED')::integer AS completed,
                count(*) FILTER (WHERE status = 'FAILED')::integer AS failed,
                count(*) FILTER (WHERE status = 'SKIPPED')::integer AS skipped,
                COALESCE(sum(members_synced) FILTER (WHERE status = 'COMPLETED'), 0)::integer AS members,
                count(*) FILTER (WHERE status IN ('PENDING','RUNNING','RETRY'))::integer AS remaining
         FROM gateway_sync_items WHERE sync_run_id = $1
       )
       UPDATE sync_runs runs SET groups_synced = aggregate.completed,
         groups_failed = aggregate.failed, groups_skipped = aggregate.skipped, members_synced = aggregate.members,
         phase = CASE WHEN aggregate.remaining = 0 THEN 'COMPLETED' ELSE 'RECONCILING' END,
         status = CASE WHEN aggregate.remaining > 0 THEN runs.status
           WHEN aggregate.failed > 0 THEN 'FAILED'::gateway_sync_status ELSE 'COMPLETED'::gateway_sync_status END,
         error = CASE WHEN aggregate.remaining = 0 AND aggregate.failed > 0
           THEN aggregate.failed || ' group reconciliations failed' ELSE runs.error END,
         completed_at = CASE WHEN aggregate.remaining = 0 THEN now() ELSE NULL END, updated_at = now()
       FROM aggregate WHERE runs.id = $1`,
      [syncRunId],
    );
  }

  private async assertDiscoveryOwnership(client: PoolClient, fence: SyncWriteFence, sessionId: string): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM sync_runs runs JOIN gateway_sync_fences fences ON fences.session_id = runs.session_id
       WHERE runs.id = $1 AND runs.session_id = $2 AND runs.status = 'RUNNING'
         AND runs.lease_token = $3 AND runs.lease_expires_at > now()
         AND runs.sync_epoch = $4::bigint AND fences.current_epoch = $4::bigint FOR UPDATE OF runs`,
      [fence.syncRunId, sessionId, fence.leaseToken, fence.syncEpoch],
    );
    if (result.rowCount !== 1) throw new Error('Gateway sync discovery lost write ownership');
  }

  private async replaceSummaries(client: PoolClient, sessionId: string, groups: OpenWAGroupSummary[]): Promise<void> {
    if (groups.length > 0) {
      await client.query(
        `INSERT INTO gateway_groups (session_id, id, name, participants_count, is_admin, linked_parent_id)
         SELECT $1, summary.id, summary.name, summary.participants_count, summary.is_admin, summary.linked_parent_id
         FROM jsonb_to_recordset($2::jsonb) AS summary(
           id text, name text, participants_count integer, is_admin boolean, linked_parent_id text)
         ON CONFLICT (session_id, id) DO UPDATE SET
           name = CASE WHEN EXCLUDED.name = $3 AND gateway_groups.details_synced_at IS NOT NULL
             THEN gateway_groups.name ELSE EXCLUDED.name END,
           participants_count = COALESCE(EXCLUDED.participants_count, gateway_groups.participants_count),
           is_admin = COALESCE(EXCLUDED.is_admin, gateway_groups.is_admin),
           linked_parent_id = EXCLUDED.linked_parent_id,
           send_capability = CASE WHEN gateway_groups.is_active = false THEN 'UNKNOWN' ELSE gateway_groups.send_capability END,
           send_capability_reason = CASE WHEN gateway_groups.is_active = false THEN 'GROUP_CHANGED' ELSE gateway_groups.send_capability_reason END,
           capability_invalidated_at = CASE WHEN gateway_groups.is_active = false THEN now() ELSE gateway_groups.capability_invalidated_at END,
           capability_revision = CASE WHEN gateway_groups.is_active = false THEN gateway_groups.capability_revision + 1 ELSE gateway_groups.capability_revision END,
           is_active = true, synced_at = now(), updated_at = now()`,
        [sessionId, JSON.stringify(groups.map(group => ({
          id: group.id, name: group.name, participants_count: group.participantsCount ?? null,
          is_admin: group.isAdmin ?? null, linked_parent_id: group.linkedParentJID ?? null,
        }))), pendingGroupName],
      );
    }
    await client.query(
      `UPDATE gateway_groups SET is_active = false, updated_at = now()
       WHERE session_id = $1 AND NOT (id = ANY($2::text[]))`,
      [sessionId, groups.map(group => group.id)],
    );
    await client.query(
      `UPDATE gateway_groups SET send_capability = 'DENIED', send_capability_reason = 'GROUP_INACTIVE',
         capability_checked_at = now(), capability_invalidated_at = NULL,
         capability_revision = capability_revision + 1, updated_at = now()
       WHERE session_id = $1 AND is_active = false
         AND (send_capability <> 'DENIED' OR send_capability_reason <> 'GROUP_INACTIVE')`,
      [sessionId],
    );
  }
}

class LostGatewaySyncLeaseError extends Error {}
