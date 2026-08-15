import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { DatabaseService } from '../../core/database/database.service';
import type { GatewaySyncFailurePolicy } from './gateway-sync-item.types';

@Injectable()
export class GatewaySyncRateLimitRepository {
  constructor(
    private readonly database: DatabaseService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async ensure(client: PoolClient, sessionId: string): Promise<void> {
    await client.query(
      `INSERT INTO gateway_sync_rate_limits (session_id, effective_requests_per_minute)
       VALUES ($1, $2) ON CONFLICT (session_id) DO UPDATE SET
         effective_requests_per_minute = LEAST(
           COALESCE(gateway_sync_rate_limits.effective_requests_per_minute,
             EXCLUDED.effective_requests_per_minute),
           EXCLUDED.effective_requests_per_minute
         )`,
      [sessionId, this.config.GATEWAY_SYNC_GROUPS_PER_MINUTE],
    );
  }

  async readyAndRate(client: PoolClient, sessionId: string): Promise<number | null> {
    const result = await client.query<{ ready: boolean; effective_requests_per_minute: number | null }>(
      `SELECT GREATEST(next_request_at, COALESCE(cooldown_until, '-infinity'::timestamptz)) <= now()
         AND (active_lease_token IS NULL OR active_lease_expires_at < now()) AS ready,
         effective_requests_per_minute
       FROM gateway_sync_rate_limits WHERE session_id = $1 FOR UPDATE`,
      [sessionId],
    );
    if (result.rows[0]?.ready !== true) return null;
    return this.config.GATEWAY_SYNC_ADAPTIVE_PACING
      ? result.rows[0].effective_requests_per_minute ?? this.config.GATEWAY_SYNC_GROUPS_PER_MINUTE
      : this.config.GATEWAY_SYNC_GROUPS_PER_MINUTE;
  }

  async acquire(client: PoolClient, sessionId: string, leaseToken: string, rate: number): Promise<void> {
    await client.query(
      `UPDATE gateway_sync_rate_limits SET
         next_request_at = now() + ($2::double precision * interval '1 millisecond'),
         active_lease_token = $3, active_lease_expires_at = now() + interval '2 minutes', updated_at = now()
       WHERE session_id = $1`,
      [sessionId, 60_000 / rate, leaseToken],
    );
  }

  async renew(client: PoolClient, sessionId: string, leaseToken: string): Promise<boolean> {
    const result = await client.query(
      `UPDATE gateway_sync_rate_limits SET active_lease_expires_at = now() + interval '2 minutes',
         updated_at = now()
       WHERE session_id = $1 AND active_lease_token = $2 AND active_lease_expires_at > now()`,
      [sessionId, leaseToken],
    );
    return result.rowCount === 1;
  }

  async success(client: PoolClient, sessionId: string, leaseToken: string): Promise<void> {
    await client.query(
      `UPDATE gateway_sync_rate_limits SET consecutive_failures = 0, cooldown_until = NULL,
         success_streak = CASE WHEN $3 THEN success_streak + 1 ELSE 0 END,
         effective_requests_per_minute = CASE
           WHEN $3 AND success_streak + 1 >= $4 THEN LEAST($5,
             COALESCE(effective_requests_per_minute, $5) + 1)
           ELSE COALESCE(effective_requests_per_minute, $5) END,
         active_lease_token = NULL, active_lease_expires_at = NULL, updated_at = now()
       WHERE session_id = $1 AND active_lease_token = $2`,
      [sessionId, leaseToken, this.config.GATEWAY_SYNC_ADAPTIVE_PACING,
        this.config.GATEWAY_SYNC_RATE_RECOVERY_SUCCESSES, this.config.GATEWAY_SYNC_GROUPS_PER_MINUTE],
    );
    if (this.config.GATEWAY_SYNC_ADAPTIVE_PACING) {
      await client.query(
        `UPDATE gateway_sync_rate_limits SET success_streak = 0
         WHERE session_id = $1 AND active_lease_token IS NULL AND success_streak >= $2`,
        [sessionId, this.config.GATEWAY_SYNC_RATE_RECOVERY_SUCCESSES],
      );
    }
    await client.query(`SELECT pg_notify('wa_runtime_gateway_work', 'group-reconciliation')`);
  }

  async failure(
    client: PoolClient,
    sessionId: string,
    leaseToken: string,
    policy: GatewaySyncFailurePolicy,
  ): Promise<void> {
    await client.query(
      `UPDATE gateway_sync_rate_limits SET
         consecutive_failures = CASE WHEN $3 THEN consecutive_failures + 1 ELSE consecutive_failures END,
         cooldown_until = CASE WHEN $3 THEN now() + COALESCE(
           $8::double precision * interval '1 millisecond',
           CASE LEAST(consecutive_failures + 1, 4)
             WHEN 1 THEN 5 WHEN 2 THEN 15 WHEN 3 THEN 30 ELSE 60 END
             * (0.8 + random() * 0.4) * interval '1 second'
         ) ELSE cooldown_until END,
         effective_requests_per_minute = CASE WHEN $4 AND $5 THEN GREATEST($6,
           floor(COALESCE(effective_requests_per_minute, $7) / 2.0)::integer)
           ELSE COALESCE(effective_requests_per_minute, $7) END,
         success_streak = CASE WHEN $3 THEN 0 ELSE success_streak END,
         last_rate_pressure_at = CASE WHEN $3 THEN now() ELSE last_rate_pressure_at END,
         active_lease_token = NULL, active_lease_expires_at = NULL, updated_at = now()
       WHERE session_id = $1 AND active_lease_token = $2`,
      [sessionId, leaseToken, policy.ratePressure, policy.reduceRate === true,
        this.config.GATEWAY_SYNC_ADAPTIVE_PACING, this.config.GATEWAY_SYNC_MIN_GROUPS_PER_MINUTE,
        this.config.GATEWAY_SYNC_GROUPS_PER_MINUTE, policy.retryAfterMs ?? null],
    );
    await client.query(`SELECT pg_notify('wa_runtime_gateway_work', 'group-reconciliation')`);
  }

  async release(client: PoolClient, sessionId: string, leaseToken: string): Promise<void> {
    await client.query(
      `UPDATE gateway_sync_rate_limits SET active_lease_token = NULL,
         active_lease_expires_at = NULL, updated_at = now()
       WHERE session_id = $1 AND active_lease_token = $2`,
      [sessionId, leaseToken],
    );
    await client.query(`SELECT pg_notify('wa_runtime_gateway_work', 'group-reconciliation')`);
  }

  async reserve(sessionId: string): Promise<string | null> {
    return this.database.transaction(async client => {
      await this.ensure(client, sessionId);
      const rate = await this.readyAndRate(client, sessionId);
      if (rate === null) return null;
      const lease = await client.query<{ lease_token: string }>('SELECT gen_random_uuid() AS lease_token');
      const leaseToken = lease.rows[0]!.lease_token;
      await this.acquire(client, sessionId, leaseToken, rate);
      return leaseToken;
    });
  }

  async record(sessionId: string, leaseToken: string, policy?: GatewaySyncFailurePolicy): Promise<void> {
    await this.database.transaction(client => policy
      ? this.failure(client, sessionId, leaseToken, policy)
      : this.success(client, sessionId, leaseToken));
  }

  async releaseLease(sessionId: string, leaseToken: string): Promise<void> {
    await this.database.transaction(client => this.release(client, sessionId, leaseToken));
  }
}
