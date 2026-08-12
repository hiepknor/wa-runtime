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

  it('allows at most one RUNNING sync per session and advances the session epoch', async () => {
    const first = await gateway.createSyncRun(INTEGRATION_SESSION_ID);
    const second = await gateway.createSyncRun(INTEGRATION_SESSION_ID);

    const claims = await Promise.all([gateway.claimSyncRun(first.id), gateway.claimSyncRun(second.id)]);
    const active = claims.find((claim): claim is NonNullable<typeof claim> => claim !== null);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(active?.syncEpoch).toBe('1');
    const running = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sync_runs
       WHERE session_id = $1 AND status = 'RUNNING'`,
      [INTEGRATION_SESSION_ID],
    );
    expect(running.rows[0]?.count).toBe('1');

    const activeId = claims[0] ? first.id : second.id;
    const pendingId = claims[0] ? second.id : first.id;
    expect(await gateway.completeSyncRun(activeId, active!.leaseToken, 0, 0)).toBe(true);

    const next = await gateway.claimSyncRun(pendingId);
    expect(next?.syncEpoch).toBe('2');
  });

  it('rejects all full-sync domain writes from a superseded epoch', async () => {
    const openwa = new OpenWAClient();
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);
    const stale = await gateway.claimSyncRun(run.id);
    expect(stale).not.toBeNull();
    const staleFence = {
      syncRunId: run.id,
      leaseToken: stale!.leaseToken,
      syncEpoch: stale!.syncEpoch,
    };
    const session = await openwa.getSession(INTEGRATION_SESSION_ID);
    await gateway.upsertSession(session, staleFence);

    await pool.query(
      `UPDATE sync_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [run.id],
    );
    await gateway.recoverExpiredSyncRuns();
    const current = await gateway.claimSyncRun(run.id);
    expect(current?.syncEpoch).toBe('2');
    const currentFence = {
      syncRunId: run.id,
      leaseToken: current!.leaseToken,
      syncEpoch: current!.syncEpoch,
    };

    await expect(gateway.upsertSession({ ...session, name: 'stale session' }, staleFence))
      .rejects.toThrow('lost write ownership');
    const groups = await openwa.listGroups(INTEGRATION_SESSION_ID);
    await expect(gateway.replaceGroupSummaries(INTEGRATION_SESSION_ID, groups, staleFence))
      .rejects.toThrow('lost write ownership');
    const group = await openwa.getGroup(INTEGRATION_SESSION_ID, groups[0]!.id);
    await expect(gateway.upsertGroupDetails(INTEGRATION_SESSION_ID, group, { syncFence: staleFence }))
      .rejects.toThrow('lost write ownership');

    await gateway.upsertSession({ ...session, name: 'current session' }, currentFence);
    await gateway.replaceGroupSummaries(INTEGRATION_SESSION_ID, groups, currentFence);
    expect(await gateway.upsertGroupDetails(INTEGRATION_SESSION_ID, group, { syncFence: currentFence }))
      .toMatchObject({ applied: true, members: 1 });
    expect(await gateway.findSession(INTEGRATION_SESSION_ID)).toMatchObject({ name: 'current session' });
  });
});
