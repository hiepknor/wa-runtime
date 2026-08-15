import { DatabaseService } from '../../core/database/database.service';
import type { GroupSendCapabilityReason } from './group-capability';

export interface ClaimedCapabilityRefresh {
  leaseToken: string;
  attemptNumber: number;
}

export type CapabilityRefreshAttemptResult = 'RETRY' | 'FAILED' | 'LOST_OWNERSHIP';

export class GatewayCapabilityRepository {
  constructor(private readonly database: DatabaseService) {}

  async invalidate(sessionId: string, groupId: string, reason: GroupSendCapabilityReason): Promise<boolean> {
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

  async listNeedingRefresh(limit: number): Promise<Array<{
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
             AND (sync_runs.status = 'PENDING'
               OR (sync_runs.status = 'RUNNING' AND sync_runs.phase = 'DISCOVERING'))
         )
         AND NOT EXISTS (
           SELECT 1 FROM gateway_group_reconciliation_intents intents
           WHERE intents.session_id = gateway_groups.session_id AND intents.group_id = gateway_groups.id
             AND intents.status IN ('PENDING', 'RUNNING', 'RETRY')
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

  async claim(
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
             AND (sync_runs.status = 'PENDING'
               OR (sync_runs.status = 'RUNNING' AND sync_runs.phase = 'DISCOVERING'))
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

  async failAttempt(
    sessionId: string,
    groupId: string,
    expectedRevision: number,
    leaseToken: string,
    error: string,
    retryable = true,
  ): Promise<CapabilityRefreshAttemptResult> {
    const result = await this.database.query<{ exhausted: boolean }>(
      `UPDATE gateway_groups SET
         send_capability = 'UNKNOWN',
         send_capability_reason = CASE WHEN NOT $6 OR capability_refresh_attempt_count >= 3
           THEN 'REFRESH_FAILED' ELSE send_capability_reason END,
         capability_checked_at = CASE WHEN NOT $6 OR capability_refresh_attempt_count >= 3
           THEN now() ELSE capability_checked_at END,
         capability_invalidated_at = CASE WHEN NOT $6 OR capability_refresh_attempt_count >= 3
           THEN NULL ELSE capability_invalidated_at END,
         capability_refresh_next_attempt_at = CASE WHEN NOT $6 OR capability_refresh_attempt_count >= 3
           THEN capability_refresh_next_attempt_at
           ELSE now() + LEAST(300, 5 * power(2, capability_refresh_attempt_count - 1)) * interval '1 second' END,
         capability_refresh_lease_token = NULL, capability_refresh_lease_expires_at = NULL,
         capability_refresh_error = $5, updated_at = now()
       WHERE session_id = $1 AND id = $2 AND capability_revision = $3
         AND capability_refresh_lease_token = $4 AND capability_refresh_lease_expires_at > now()
       RETURNING NOT $6 OR capability_refresh_attempt_count >= 3 AS exhausted`,
      [sessionId, groupId, expectedRevision, leaseToken, error, retryable],
    );
    const row = result.rows[0];
    return row ? (row.exhausted ? 'FAILED' : 'RETRY') : 'LOST_OWNERSHIP';
  }

  async recoverExpired(): Promise<number> {
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
}
