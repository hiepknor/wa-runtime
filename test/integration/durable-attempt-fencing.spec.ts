import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { CampaignRunRepository } from '../../src/modules/campaigns/campaign-run.repository';
import { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import {
  INTEGRATION_GROUP_ID,
  INTEGRATION_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
  seedSendableGroup,
} from '../support/integration-database';

describe('durable attempt fencing', () => {
  let pool: Pool;
  let database: DatabaseService;
  let gateway: GatewayRepository;
  let campaigns: CampaignRunRepository;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    gateway = new GatewayRepository(database);
    campaigns = new CampaignRunRepository(database, new MessageJobRepository(database));
  });
  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await seedSendableGroup(pool);
  });
  afterAll(async () => {
    await database.onApplicationShutdown();
    await pool.end();
  });

  it('prevents a stale campaign preparation from failing a reclaimed attempt', async () => {
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (session_id, name, payload)
       VALUES ($1, 'Fencing', '{"text":"hello"}') RETURNING id`,
      [INTEGRATION_SESSION_ID],
    );
    const run = await pool.query<{ id: string }>(
      `INSERT INTO campaign_runs
         (campaign_id, session_id, idempotency_key, execution_mode, payload_snapshot, scheduled_at)
       VALUES ($1, $2, 'fencing-run', 'DRY_RUN', '{"text":"hello"}', now()) RETURNING id`,
      [campaign.rows[0]!.id, INTEGRATION_SESSION_ID],
    );
    const runId = run.rows[0]!.id;
    const stale = await campaigns.claimPreparation(runId);
    expect(stale).not.toBeNull();
    await pool.query(
      `UPDATE campaign_runs SET preparation_lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [runId],
    );
    await campaigns.recoverExpiredPreparations();
    const current = await campaigns.claimPreparation(runId);
    expect(current).not.toBeNull();

    expect(await campaigns.failPreparationAttempt(
      runId,
      stale!.leaseToken,
      'stale failure',
    )).toBe('LOST_OWNERSHIP');
    expect(await campaigns.failPreparationAttempt(
      runId,
      current!.leaseToken,
      'current failure',
    )).toBe('PREPARING');
  });

  it('prevents a stale capability refresh from failing a reclaimed attempt', async () => {
    await gateway.invalidateGroupCapability(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, 'MANUAL_REFRESH');
    const group = await gateway.findGroup(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID);
    const revision = group!.sendCapability.revision;
    const stale = await gateway.claimCapabilityRefresh(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, revision);
    expect(stale).not.toBeNull();
    await pool.query(
      `UPDATE gateway_groups SET capability_refresh_lease_expires_at = now() - interval '1 second'
       WHERE session_id = $1 AND id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    await gateway.recoverExpiredCapabilityRefreshes();
    const current = await gateway.claimCapabilityRefresh(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, revision);
    expect(current).not.toBeNull();

    expect(await gateway.failCapabilityRefreshAttempt(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      revision,
      stale!.leaseToken,
      'stale failure',
    )).toBe('LOST_OWNERSHIP');
    expect(await gateway.failCapabilityRefreshAttempt(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      revision,
      current!.leaseToken,
      'current failure',
    )).toBe('RETRY');
  });

  it('terminates a non-retryable capability refresh failure immediately', async () => {
    await gateway.invalidateGroupCapability(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, 'MANUAL_REFRESH');
    const group = await gateway.findGroup(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID);
    const revision = group!.sendCapability.revision;
    const claim = await gateway.claimCapabilityRefresh(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, revision);
    expect(claim).not.toBeNull();

    expect(await gateway.failCapabilityRefreshAttempt(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      revision,
      claim!.leaseToken,
      'UPSTREAM_VALIDATION_ERROR',
      false,
    )).toBe('FAILED');
    expect(await gateway.claimCapabilityRefresh(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      revision,
    )).toBeNull();
  });

  it('suppresses capability refresh claims while a full session sync is running', async () => {
    await gateway.invalidateGroupCapability(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, 'MANUAL_REFRESH');
    const group = await gateway.findGroup(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID);
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);

    expect(await gateway.listGroupsNeedingCapabilityRefresh(10)).toEqual([]);
    expect(await gateway.claimCapabilityRefresh(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      group!.sendCapability.revision,
    )).toBeNull();

    const syncClaim = await gateway.claimSyncRun(run.id);
    expect(syncClaim).not.toBeNull();

    expect(await gateway.listGroupsNeedingCapabilityRefresh(10)).toEqual([]);
    expect(await gateway.claimCapabilityRefresh(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      group!.sendCapability.revision,
    )).toBeNull();

    expect(await gateway.completeSyncRun(run.id, syncClaim!.leaseToken, 0, 0)).toBe(true);
    expect(await gateway.listGroupsNeedingCapabilityRefresh(10)).toHaveLength(1);
    expect(await gateway.claimCapabilityRefresh(
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      group!.sendCapability.revision,
    )).not.toBeNull();
  });
});
