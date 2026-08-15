import type { PoolClient } from 'pg';
import type { GroupIntentWriteFence, SyncItemWriteFence } from './gateway-sync-item.types';

export interface SyncWriteFence {
  syncRunId: string;
  leaseToken: string;
  syncEpoch: string;
}

export class GatewayWriteFenceRepository {
  async assertSyncWriteOwnership(
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

  async assertSyncItemWriteOwnership(client: PoolClient, fence: SyncItemWriteFence): Promise<void> {
    const ownership = await client.query(
      `SELECT 1 FROM gateway_sync_items items
       JOIN sync_runs runs ON runs.id = items.sync_run_id
       JOIN gateway_sync_fences fences ON fences.session_id = items.session_id
       WHERE items.id = $1 AND items.sync_run_id = $2 AND items.session_id = $3
         AND items.status = 'RUNNING' AND items.lease_token = $4 AND items.lease_expires_at > now()
         AND runs.status = 'RUNNING' AND runs.sync_epoch = $5::bigint
         AND fences.current_epoch = $5::bigint FOR SHARE OF items, runs, fences`,
      [fence.itemId, fence.syncRunId, fence.sessionId, fence.leaseToken, fence.syncEpoch],
    );
    if (ownership.rowCount !== 1) throw new Error('Gateway sync item lost write ownership');
  }

  async assertGroupIntentWriteOwnership(client: PoolClient, fence: GroupIntentWriteFence): Promise<void> {
    const ownership = await client.query(
      `SELECT 1 FROM gateway_group_reconciliation_intents
       WHERE session_id = $1 AND group_id = $2 AND status = 'RUNNING'
         AND lease_token = $3 AND lease_expires_at > now() AND claimed_revision = $4 FOR UPDATE`,
      [fence.sessionId, fence.groupId, fence.leaseToken, fence.claimedRevision],
    );
    if (ownership.rowCount !== 1) throw new Error('Gateway group intent lost write ownership');
  }

  async renewGroupReadPacingLease(
    client: PoolClient,
    sessionId: string,
    leaseToken: string,
  ): Promise<void> {
    const renewed = await client.query(
      `UPDATE gateway_sync_rate_limits
       SET active_lease_expires_at = clock_timestamp() + interval '2 minutes',
         updated_at = clock_timestamp()
       WHERE session_id = $1 AND active_lease_token = $2`,
      [sessionId, leaseToken],
    );
    if (renewed.rowCount !== 1) throw new Error('Gateway group read pacing lease lost ownership');
  }
}
