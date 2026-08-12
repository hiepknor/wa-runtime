import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { OpenWAClient } from '../../src/integrations/openwa/openwa.client';
import { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import { GatewaySyncService } from '../../src/modules/gateway/gateway-sync.service';
import { INTEGRATION_SESSION_ID, integrationPool, resetIntegrationDatabase } from '../support/integration-database';

describe('gateway sync recovery', () => {
  let pool: Pool;
  let database: DatabaseService;
  let gateway: GatewayRepository;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    gateway = new GatewayRepository(database);
  });
  beforeEach(() => resetIntegrationDatabase(pool));
  afterAll(async () => { await database.onApplicationShutdown(); await pool.end(); });

  it('returns an expired RUNNING sync to durable PENDING state', async () => {
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);
    const claim = await gateway.claimSyncRun(run.id);
    expect(claim).not.toBeNull();
    await pool.query(`UPDATE sync_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [run.id]);

    expect(await gateway.recoverExpiredSyncRuns()).toBe(1);
    expect(await gateway.findSyncRun(run.id)).toMatchObject({
      status: 'PENDING', error: 'Recovered expired sync lease',
    });
    expect(await gateway.listPendingSyncRuns(10)).toHaveLength(1);
  });

  it('synchronizes the fake OpenWA snapshot into the durable read model', async () => {
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);

    await new GatewaySyncService(gateway, new OpenWAClient()).perform(run.id);

    expect(await gateway.findSyncRun(run.id)).toMatchObject({ status: 'COMPLETED', groupsSynced: 1, membersSynced: 1 });
    expect(await gateway.findGroup(INTEGRATION_SESSION_ID, '120363000000000000@g.us')).toMatchObject({
      sendCapability: { status: 'ALLOWED', reason: 'SEND_ALLOWED' },
    });
  });

  it('fences a stale sync attempt after lease recovery and reclaim', async () => {
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);
    const stale = await gateway.claimSyncRun(run.id);
    expect(stale).not.toBeNull();
    await pool.query(
      `UPDATE sync_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [run.id],
    );
    await gateway.recoverExpiredSyncRuns();
    const current = await gateway.claimSyncRun(run.id);
    expect(current).not.toBeNull();
    expect(current!.leaseToken).not.toBe(stale!.leaseToken);

    expect(await gateway.completeSyncRun(run.id, stale!.leaseToken, 1, 1)).toBe(false);
    expect(await gateway.failSyncRunAttempt(
      run.id,
      stale!.leaseToken,
      1,
      1,
      'stale failure',
    )).toBe('LOST_OWNERSHIP');
    expect(await gateway.completeSyncRun(run.id, current!.leaseToken, 2, 3)).toBe(true);
    expect(await gateway.findSyncRun(run.id)).toMatchObject({
      status: 'COMPLETED', groupsSynced: 2, membersSynced: 3,
    });
  });
});
