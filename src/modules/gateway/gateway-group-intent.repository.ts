import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { DatabaseService } from '../../core/database/database.service';
import type {
  ClaimedGatewayGroupIntent,
  GatewayGroupIntentDispatch,
  GatewayGroupIntentFailurePolicy,
} from './gateway-group-intent.types';
import { GatewaySyncRateLimitRepository } from './gateway-sync-rate-limit.repository';

@Injectable()
export class GatewayGroupIntentRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly rateLimits: GatewaySyncRateLimitRepository = new GatewaySyncRateLimitRepository(database),
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async scheduleInTransaction(
    client: PoolClient,
    sessionId: string,
    groupId: string,
    reason: string,
  ): Promise<{ created: boolean; coalescedCount: number }> {
    const result = await client.query<{ created: boolean; coalesced_count: string }>(
      `INSERT INTO gateway_group_reconciliation_intents
         (session_id, group_id, reasons, not_before, next_attempt_at)
       VALUES ($1, $2, ARRAY[$3],
         now() + ($4::double precision * interval '1 millisecond'),
         now() + ($4::double precision * interval '1 millisecond'))
       ON CONFLICT (session_id, group_id) DO UPDATE SET
         requested_revision = gateway_group_reconciliation_intents.requested_revision + 1,
         reasons = CASE WHEN gateway_group_reconciliation_intents.status IN ('COMPLETED', 'FAILED')
           THEN EXCLUDED.reasons ELSE ARRAY(
             SELECT DISTINCT value FROM unnest(
               gateway_group_reconciliation_intents.reasons || EXCLUDED.reasons
             ) AS value ORDER BY value
           ) END,
         status = CASE WHEN gateway_group_reconciliation_intents.status = 'RUNNING'
           THEN 'RUNNING'::gateway_group_intent_status ELSE 'PENDING'::gateway_group_intent_status END,
         not_before = LEAST(
           (CASE WHEN gateway_group_reconciliation_intents.status IN ('COMPLETED', 'FAILED')
             THEN now() ELSE gateway_group_reconciliation_intents.first_requested_at END)
             + ($5::double precision * interval '1 millisecond'),
           now() + ($4::double precision * interval '1 millisecond')
         ),
         next_attempt_at = CASE WHEN gateway_group_reconciliation_intents.status = 'RUNNING'
           THEN gateway_group_reconciliation_intents.next_attempt_at
           ELSE LEAST(
             (CASE WHEN gateway_group_reconciliation_intents.status IN ('COMPLETED', 'FAILED')
               THEN now() ELSE gateway_group_reconciliation_intents.first_requested_at END)
               + ($5::double precision * interval '1 millisecond'),
             now() + ($4::double precision * interval '1 millisecond')
           ) END,
         attempt_count = CASE WHEN gateway_group_reconciliation_intents.status = 'RUNNING'
           THEN gateway_group_reconciliation_intents.attempt_count ELSE 0 END,
         coalesced_count = CASE WHEN gateway_group_reconciliation_intents.status IN ('COMPLETED', 'FAILED')
           THEN 0 ELSE gateway_group_reconciliation_intents.coalesced_count + 1 END,
         first_requested_at = CASE WHEN gateway_group_reconciliation_intents.status IN ('COMPLETED', 'FAILED')
           THEN now() ELSE gateway_group_reconciliation_intents.first_requested_at END,
         last_requested_at = now(),
         started_at = CASE WHEN gateway_group_reconciliation_intents.status IN ('COMPLETED', 'FAILED')
           THEN NULL ELSE gateway_group_reconciliation_intents.started_at END,
         completed_at = NULL, last_error_code = NULL, updated_at = now()
       RETURNING (xmax = 0) AS created, coalesced_count::text`,
      [sessionId, groupId, reason, this.config.GATEWAY_GROUP_EVENT_DEBOUNCE_MS,
        this.config.GATEWAY_GROUP_EVENT_MAX_WAIT_MS],
    );
    await client.query(`SELECT pg_notify('wa_runtime_gateway_work', 'group-reconciliation')`);
    const row = result.rows[0]!;
    return { created: row.created, coalescedCount: Number(row.coalesced_count) };
  }

  async listDispatchable(limit: number): Promise<GatewayGroupIntentDispatch[]> {
    if (!this.config.GATEWAY_TARGETED_RECONCILIATION_ENABLED) return [];
    const result = await this.database.query<{
      session_id: string; group_id: string; requested_revision: string; available_at: Date;
    }>(
      `SELECT intents.session_id, intents.group_id, intents.requested_revision::text,
         GREATEST(intents.next_attempt_at, intents.not_before,
           COALESCE(limits.next_request_at, '-infinity'::timestamptz),
           COALESCE(limits.cooldown_until, '-infinity'::timestamptz),
           CASE WHEN limits.active_lease_token IS NOT NULL
             THEN COALESCE(limits.active_lease_expires_at, now()) ELSE '-infinity'::timestamptz END
         ) AS available_at
       FROM gateway_group_reconciliation_intents intents
       LEFT JOIN gateway_sync_rate_limits limits ON limits.session_id = intents.session_id
       WHERE intents.status IN ('PENDING', 'RETRY')
         AND intents.attempt_count < $2
         AND intents.session_id = ANY($3::text[])
         AND NOT EXISTS (
           SELECT 1 FROM sync_runs WHERE sync_runs.session_id = intents.session_id
             AND sync_runs.status IN ('PENDING', 'RUNNING') AND sync_runs.phase = 'DISCOVERING'
         )
         AND (limits.active_lease_token IS NULL OR limits.active_lease_expires_at < now())
         AND NOT EXISTS (
           SELECT 1 FROM gateway_sync_items items
           JOIN sync_runs runs ON runs.id = items.sync_run_id AND runs.status = 'RUNNING'
           WHERE items.session_id = intents.session_id AND items.group_id = intents.group_id
             AND items.status IN ('PENDING', 'RUNNING', 'RETRY')
         )
       ORDER BY available_at, intents.last_requested_at
       LIMIT $1`,
      [limit, this.config.GATEWAY_SYNC_ITEM_MAX_ATTEMPTS, this.config.OPENWA_ALLOWED_SESSION_IDS],
    );
    return result.rows.map(row => ({
      sessionId: row.session_id, groupId: row.group_id,
      requestedRevision: Number(row.requested_revision),
      availableAt: row.available_at,
    }));
  }

  async claim(sessionId: string, groupId: string): Promise<ClaimedGatewayGroupIntent | null> {
    return this.database.transaction(async client => {
      const intent = await client.query<{
        requested_revision: string; coalesced_count: string; first_requested_at: Date;
      }>(
        `SELECT requested_revision::text, coalesced_count::text, first_requested_at
         FROM gateway_group_reconciliation_intents
         WHERE session_id = $1 AND group_id = $2 FOR UPDATE`,
        [sessionId, groupId],
      );
      const row = intent.rows[0];
      if (!row) return null;
      await this.rateLimits.ensure(client, sessionId);
      const effectiveRate = await this.rateLimits.readyAndRate(client, sessionId);
      if (effectiveRate === null) return null;
      const claimed = await client.query<{ lease_token: string; attempt_count: number }>(
        `UPDATE gateway_group_reconciliation_intents SET status = 'RUNNING',
           claimed_revision = requested_revision, attempt_count = attempt_count + 1,
           lease_token = gen_random_uuid(), lease_expires_at = now() + interval '2 minutes',
           started_at = COALESCE(started_at, now()), last_error_code = NULL, updated_at = now()
         WHERE session_id = $1 AND group_id = $2 AND status IN ('PENDING', 'RETRY')
           AND next_attempt_at <= now() AND not_before <= now() AND attempt_count < $3
         RETURNING lease_token, attempt_count`,
        [sessionId, groupId, this.config.GATEWAY_SYNC_ITEM_MAX_ATTEMPTS],
      );
      const claim = claimed.rows[0];
      if (!claim) return null;
      await this.rateLimits.acquire(client, sessionId, claim.lease_token, effectiveRate);
      return {
        sessionId, groupId, requestedRevision: Number(row.requested_revision),
        leaseToken: claim.lease_token, attemptNumber: claim.attempt_count,
        coalescedCount: Number(row.coalesced_count), requestedAt: row.first_requested_at,
      };
    });
  }

  async renewLease(sessionId: string, groupId: string, leaseToken: string): Promise<boolean> {
    return this.database.transaction(async client => {
      const result = await client.query(
        `UPDATE gateway_group_reconciliation_intents
         SET lease_expires_at = now() + interval '2 minutes', updated_at = now()
         WHERE session_id = $1 AND group_id = $2 AND status = 'RUNNING'
           AND lease_token = $3 AND lease_expires_at > now()`,
        [sessionId, groupId, leaseToken],
      );
      if (result.rowCount !== 1 || !await this.rateLimits.renew(client, sessionId, leaseToken)) {
        throw new LostGatewayGroupIntentLeaseError();
      }
      return true;
    }).catch(error => {
      if (error instanceof LostGatewayGroupIntentLeaseError) return false;
      throw error;
    });
  }

  async complete(
    sessionId: string,
    groupId: string,
    leaseToken: string,
    claimedRevision: number,
  ): Promise<'COMPLETED' | 'PENDING' | 'LOST_OWNERSHIP'> {
    return this.database.transaction(async client => {
      const result = await client.query<{ status: 'COMPLETED' | 'PENDING' }>(
        `UPDATE gateway_group_reconciliation_intents SET
           completed_revision = GREATEST(completed_revision, $4),
           status = CASE WHEN requested_revision > $4
             THEN 'PENDING'::gateway_group_intent_status ELSE 'COMPLETED'::gateway_group_intent_status END,
           attempt_count = CASE WHEN requested_revision > $4 THEN 0 ELSE attempt_count END,
           next_attempt_at = CASE WHEN requested_revision > $4 THEN GREATEST(not_before, now())
             ELSE next_attempt_at END,
           claimed_revision = NULL, lease_token = NULL, lease_expires_at = NULL,
           completed_at = CASE WHEN requested_revision = $4 THEN now() ELSE NULL END,
           last_error_code = NULL, updated_at = now()
         WHERE session_id = $1 AND group_id = $2 AND status = 'RUNNING'
           AND lease_token = $3 AND lease_expires_at > now() AND claimed_revision = $4
         RETURNING status`,
        [sessionId, groupId, leaseToken, claimedRevision],
      );
      const row = result.rows[0];
      if (!row) return 'LOST_OWNERSHIP';
      await this.rateLimits.success(client, sessionId, leaseToken);
      if (row.status === 'PENDING') {
        await client.query(`SELECT pg_notify('wa_runtime_gateway_work', 'group-reconciliation')`);
      }
      return row.status;
    });
  }

  async skipMissing(
    sessionId: string,
    groupId: string,
    leaseToken: string,
    claimedRevision: number,
  ): Promise<boolean> {
    return this.database.transaction(async client => {
      const result = await client.query<{ status: 'COMPLETED' | 'PENDING' }>(
        `UPDATE gateway_group_reconciliation_intents SET
           completed_revision = GREATEST(completed_revision, $4),
           status = CASE WHEN requested_revision > $4
             THEN 'PENDING'::gateway_group_intent_status ELSE 'COMPLETED'::gateway_group_intent_status END,
           attempt_count = CASE WHEN requested_revision > $4 THEN 0 ELSE attempt_count END,
           next_attempt_at = CASE WHEN requested_revision > $4 THEN GREATEST(not_before, now())
             ELSE next_attempt_at END,
           claimed_revision = NULL, lease_token = NULL, lease_expires_at = NULL,
           completed_at = CASE WHEN requested_revision = $4 THEN now() ELSE NULL END,
           last_error_code = 'GROUP_NOT_FOUND', updated_at = now()
         WHERE session_id = $1 AND group_id = $2 AND status = 'RUNNING'
           AND lease_token = $3 AND lease_expires_at > now() AND claimed_revision = $4
         RETURNING status`,
        [sessionId, groupId, leaseToken, claimedRevision],
      );
      if (result.rowCount !== 1) return false;
      await this.rateLimits.release(client, sessionId, leaseToken);
      if (result.rows[0]?.status === 'PENDING') {
        await client.query(`SELECT pg_notify('wa_runtime_gateway_work', 'group-reconciliation')`);
      }
      return true;
    });
  }

  async fail(
    sessionId: string,
    groupId: string,
    leaseToken: string,
    claimedRevision: number,
    policy: GatewayGroupIntentFailurePolicy,
  ): Promise<'RETRY' | 'FAILED' | 'PENDING' | 'LOST_OWNERSHIP'> {
    return this.database.transaction(async client => {
      const owned = await client.query<{ attempt_count: number; requested_revision: string }>(
        `SELECT attempt_count, requested_revision::text
         FROM gateway_group_reconciliation_intents
         WHERE session_id = $1 AND group_id = $2 AND status = 'RUNNING'
           AND lease_token = $3 AND lease_expires_at > now() AND claimed_revision = $4 FOR UPDATE`,
        [sessionId, groupId, leaseToken, claimedRevision],
      );
      const row = owned.rows[0];
      if (!row) return 'LOST_OWNERSHIP';
      const newerRevision = Number(row.requested_revision) > claimedRevision;
      const willRetry = policy.retryable && row.attempt_count < this.config.GATEWAY_SYNC_ITEM_MAX_ATTEMPTS;
      const status = newerRevision ? 'PENDING' : willRetry ? 'RETRY' : 'FAILED';
      const delaySeconds = Math.min(300, 5 * 2 ** Math.max(0, row.attempt_count - 1))
        * (0.8 + Math.random() * 0.4);
      await client.query(
        `UPDATE gateway_group_reconciliation_intents SET status = $5::gateway_group_intent_status,
           attempt_count = CASE WHEN $5 = 'PENDING' THEN 0 ELSE attempt_count END,
           next_attempt_at = CASE WHEN $5 = 'PENDING' THEN GREATEST(not_before, now())
             WHEN $5 = 'RETRY' THEN now() + ($6::double precision * interval '1 second')
             ELSE next_attempt_at END,
           claimed_revision = NULL, lease_token = NULL, lease_expires_at = NULL,
           last_error_code = $7, completed_at = CASE WHEN $5 = 'FAILED' THEN now() ELSE NULL END,
           updated_at = now()
         WHERE session_id = $1 AND group_id = $2 AND lease_token = $3 AND claimed_revision = $4`,
        [sessionId, groupId, leaseToken, claimedRevision, status, delaySeconds, policy.code],
      );
      await this.rateLimits.failure(client, sessionId, leaseToken, policy);
      if (status !== 'FAILED') {
        await client.query(`SELECT pg_notify('wa_runtime_gateway_work', 'group-reconciliation')`);
      }
      return status;
    });
  }

  async recoverExpired(): Promise<number> {
    const result = await this.database.query(
      `WITH recovered AS (
         UPDATE gateway_group_reconciliation_intents SET
           status = CASE WHEN requested_revision > COALESCE(claimed_revision, completed_revision)
             THEN 'PENDING'::gateway_group_intent_status WHEN attempt_count >= $1
             THEN 'FAILED'::gateway_group_intent_status ELSE 'RETRY'::gateway_group_intent_status END,
           attempt_count = CASE WHEN requested_revision > COALESCE(claimed_revision, completed_revision)
             THEN 0 ELSE attempt_count END,
           claimed_revision = NULL, lease_token = NULL, lease_expires_at = NULL,
           next_attempt_at = CASE
             WHEN requested_revision > COALESCE(claimed_revision, completed_revision) THEN GREATEST(not_before, now())
             WHEN attempt_count >= $1 THEN next_attempt_at ELSE now() END,
           last_error_code = 'LEASE_EXPIRED', updated_at = now()
         WHERE status = 'RUNNING' AND lease_expires_at < now()
         RETURNING session_id, status
       ), released AS (
         UPDATE gateway_sync_rate_limits limits SET active_lease_token = NULL,
           active_lease_expires_at = NULL, updated_at = now()
         FROM recovered WHERE limits.session_id = recovered.session_id
           AND limits.active_lease_expires_at < now()
       ) SELECT count(*)::integer AS count FROM recovered`,
      [this.config.GATEWAY_SYNC_ITEM_MAX_ATTEMPTS],
    );
    return Number((result.rows[0] as { count?: number } | undefined)?.count ?? 0);
  }

}

class LostGatewayGroupIntentLeaseError extends Error {}
