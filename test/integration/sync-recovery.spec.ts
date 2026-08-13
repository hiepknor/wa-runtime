import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { OpenWAClient, OpenWAHttpError, pendingGroupName } from '../../src/integrations/openwa/openwa.client';
import { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import { GatewaySyncService } from '../../src/modules/gateway/gateway-sync.service';
import { GatewaySyncItemRepository } from '../../src/modules/gateway/gateway-sync-item.repository';
import { GatewaySyncMode } from '../../src/contracts/sessions/sync-request.dto';
import { INTEGRATION_GROUP_ID, INTEGRATION_SESSION_ID, integrationPool, resetIntegrationDatabase } from '../support/integration-database';

describe('gateway sync recovery', () => {
  let pool: Pool;
  let database: DatabaseService;
  let gateway: GatewayRepository;
  let items: GatewaySyncItemRepository;

  const listRunItems = async (syncRunId: string) => {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM gateway_sync_items WHERE sync_run_id = $1 ORDER BY ordinal`,
      [syncRunId],
    );
    return result.rows;
  };

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    gateway = new GatewayRepository(database);
    items = new GatewaySyncItemRepository(database);
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

    const sync = new GatewaySyncService(gateway, items, new OpenWAClient());
    await sync.perform(run.id);
    const [item] = await items.listDispatchable(10);
    expect(item).toBeDefined();
    await sync.reconcileGroup(item!.id);

    expect(await gateway.findSyncRun(run.id)).toMatchObject({ status: 'COMPLETED', groupsSynced: 1, membersSynced: 1 });
    expect(await gateway.findGroup(INTEGRATION_SESSION_ID, '120363000000000000@g.us')).toMatchObject({
      sendCapability: { status: 'ALLOWED', reason: 'SEND_ALLOWED' },
    });
  });

  it('resumes group details after a failed attempt without overwriting hydrated subjects', async () => {
    const session = await new OpenWAClient().getSession(INTEGRATION_SESSION_ID);
    const firstId = 'resume-first@g.us';
    const secondId = 'resume-second@g.us';
    const summaries = [firstId, secondId].map(id => ({ id, name: pendingGroupName }));
    let secondAttempts = 0;
    const getGroup = vi.fn(async (_sessionId: string, groupId: string) => {
      if (groupId === secondId && secondAttempts++ === 0) throw new Error('transient group failure');
      return {
        id: groupId,
        name: groupId === firstId ? 'Hydrated first subject' : 'Hydrated second subject',
        participants: [{
          id: `${groupId}-participant`, number: '84970000000', name: null,
          isAdmin: false, isSuperAdmin: false,
        }],
      };
    });
    const openwa = {
      assertCompatibleRelease: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockResolvedValue(session),
      listGroups: vi.fn().mockResolvedValue(summaries),
      getGroup,
    } as unknown as OpenWAClient;
    const sync = new GatewaySyncService(gateway, items, openwa);
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);

    await expect(sync.perform(run.id)).resolves.toEqual({ groups: 2, members: 0 });
    const pending = await listRunItems(run.id);
    expect(pending).toHaveLength(2);
    await sync.reconcileGroup(pending[0]!.id);
    await pool.query(`UPDATE gateway_sync_rate_limits SET next_request_at = now() - interval '1 second'`);
    await expect(sync.reconcileGroup(pending[1]!.id)).rejects.toThrow('transient group failure');
    expect(getGroup.mock.calls.map(call => call[1])).toEqual([firstId, secondId]);
    expect(await gateway.findGroup(INTEGRATION_SESSION_ID, firstId)).toMatchObject({
      name: 'Hydrated first subject',
    });
    await pool.query(
      `UPDATE gateway_sync_items SET next_attempt_at = now();
       UPDATE gateway_sync_rate_limits SET next_request_at = now(), cooldown_until = NULL`,
    );
    await expect(sync.reconcileGroup(pending[1]!.id)).resolves.toEqual({ members: 1 });
    expect(getGroup.mock.calls.map(call => call[1])).toEqual([firstId, secondId, secondId]);
    expect(await gateway.findSyncRun(run.id)).toMatchObject({
      status: 'COMPLETED', groupsSynced: 2, membersSynced: 2,
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

    expect(second.id).toBe(first.id);

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

    expect(await gateway.completeSyncRun(first.id, active!.leaseToken, 0, 0)).toBe(true);
    const nextRun = await gateway.createSyncRun(INTEGRATION_SESSION_ID);
    const next = await gateway.claimSyncRun(nextRun.id);
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

  it('bulk-replaces thousands of synchronized members in one group transaction', async () => {
    const openwa = new OpenWAClient();
    await gateway.upsertSession(await openwa.getSession(INTEGRATION_SESSION_ID));
    const participantCount = 3000;
    const result = await gateway.upsertGroupDetails(INTEGRATION_SESSION_ID, {
      id: 'large-group@g.us',
      name: 'Large integration group',
      isAdmin: true,
      participants: Array.from({ length: participantCount }, (_, index) => ({
        id: `participant-${index}@c.us`,
        number: `8497${String(index).padStart(7, '0')}`,
        name: index % 3 === 0 ? `Member ${index}` : null,
        isAdmin: index < 10,
        isSuperAdmin: index === 0,
      })),
    });

    expect(result).toEqual({ applied: true, members: participantCount });
    const persisted = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM group_members
       WHERE session_id = $1 AND group_id = 'large-group@g.us'`,
      [INTEGRATION_SESSION_ID],
    );
    expect(persisted.rows[0]?.count).toBe(String(participantCount));
  });

  it('publishes summaries before detail reconciliation and reports live durable progress', async () => {
    const session = await new OpenWAClient().getSession(INTEGRATION_SESSION_ID);
    const groupIds = ['progress-1@g.us', 'progress-2@g.us', 'progress-3@g.us'];
    const openwa = {
      assertCompatibleRelease: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockResolvedValue(session),
      listGroups: vi.fn().mockResolvedValue(groupIds.map(id => ({ id, name: id }))),
      getGroup: vi.fn(async (_sessionId: string, id: string) => ({
        id, name: id, participants: [{
          id: `${id}-member`, number: id, name: null, isAdmin: false, isSuperAdmin: false,
        }],
      })),
    } as unknown as OpenWAClient;
    const sync = new GatewaySyncService(gateway, items, openwa);
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);

    await sync.perform(run.id);
    expect(await gateway.findSyncRun(run.id)).toMatchObject({
      status: 'RUNNING', phase: 'RECONCILING', groupsDiscovered: 3,
      groupsScheduled: 3, groupsSynced: 0, membersSynced: 0,
    });
    expect(await gateway.findGroup(INTEGRATION_SESSION_ID, groupIds[2]!)).toMatchObject({
      name: groupIds[2], detailsSyncedAt: null,
    });

    const pending = await listRunItems(run.id);
    await sync.reconcileGroup(pending[0]!.id);
    expect(await gateway.findSyncRun(run.id)).toMatchObject({
      status: 'RUNNING', groupsSynced: 1, membersSynced: 1,
    });
    for (const item of pending.slice(1)) {
      await pool.query('UPDATE gateway_sync_rate_limits SET next_request_at = now()');
      await sync.reconcileGroup(item.id);
    }
    expect(await gateway.findSyncRun(run.id)).toMatchObject({
      status: 'COMPLETED', phase: 'COMPLETED', groupsSynced: 3, groupsFailed: 0, membersSynced: 3,
    });
  });

  it('incremental discovery skips fresh unchanged groups and selects invalidated groups', async () => {
    const openwa = new OpenWAClient();
    const session = await openwa.getSession(INTEGRATION_SESSION_ID);
    await gateway.upsertSession(session);
    const summaries = await openwa.listGroups(INTEGRATION_SESSION_ID);
    const detail = await openwa.getGroup(INTEGRATION_SESSION_ID, summaries[0]!.id);
    await gateway.upsertGroupDetails(INTEGRATION_SESSION_ID, detail);

    const fingerprintRun = await gateway.createSyncRun(INTEGRATION_SESSION_ID, GatewaySyncMode.INCREMENTAL);
    const fingerprintClaim = await gateway.claimSyncRun(fingerprintRun.id);
    expect(fingerprintClaim).not.toBeNull();
    await items.publishDiscovery({
      syncRunId: fingerprintRun.id,
      leaseToken: fingerprintClaim!.leaseToken,
      syncEpoch: fingerprintClaim!.syncEpoch,
    }, INTEGRATION_SESSION_ID, GatewaySyncMode.INCREMENTAL, summaries);
    const [fingerprintItem] = await items.listDispatchable(10);
    const fingerprintItemClaim = await items.claim(fingerprintItem!.id);
    expect(fingerprintItemClaim).not.toBeNull();
    await items.complete(fingerprintItemClaim!.id, fingerprintItemClaim!.leaseToken, detail.participants.length);

    const baseline = await gateway.createSyncRun(INTEGRATION_SESSION_ID, GatewaySyncMode.INCREMENTAL);
    const baselineClaim = await gateway.claimSyncRun(baseline.id);
    await items.publishDiscovery({
      syncRunId: baseline.id, leaseToken: baselineClaim!.leaseToken, syncEpoch: baselineClaim!.syncEpoch,
    }, INTEGRATION_SESSION_ID, GatewaySyncMode.INCREMENTAL, summaries);
    expect(await gateway.findSyncRun(baseline.id)).toMatchObject({
      status: 'COMPLETED', groupsScheduled: 0,
    });

    await gateway.invalidateGroupCapability(INTEGRATION_SESSION_ID, detail.id, 'GROUP_CHANGED');
    const invalidated = await gateway.createSyncRun(INTEGRATION_SESSION_ID, GatewaySyncMode.INCREMENTAL);
    const invalidatedClaim = await gateway.claimSyncRun(invalidated.id);
    await items.publishDiscovery({
      syncRunId: invalidated.id,
      leaseToken: invalidatedClaim!.leaseToken,
      syncEpoch: invalidatedClaim!.syncEpoch,
    }, INTEGRATION_SESSION_ID, GatewaySyncMode.INCREMENTAL, summaries);
    expect(await gateway.findSyncRun(invalidated.id)).toMatchObject({
      status: 'RUNNING', groupsScheduled: 1,
    });
  });

  it('recovers an expired item lease without replaying completed siblings', async () => {
    const session = await new OpenWAClient().getSession(INTEGRATION_SESSION_ID);
    const ids = ['completed-sibling@g.us', 'expired-sibling@g.us'];
    const openwa = {
      assertCompatibleRelease: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockResolvedValue(session),
      listGroups: vi.fn().mockResolvedValue(ids.map(id => ({ id, name: id }))),
      getGroup: vi.fn(async (_sessionId: string, id: string) => ({ id, name: id, participants: [] })),
    } as unknown as OpenWAClient;
    const sync = new GatewaySyncService(gateway, items, openwa);
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);
    await sync.perform(run.id);
    const pending = await listRunItems(run.id);
    await sync.reconcileGroup(pending[0]!.id);
    await pool.query('UPDATE gateway_sync_rate_limits SET next_request_at = now()');
    const claimed = await items.claim(pending[1]!.id);
    expect(claimed).not.toBeNull();
    await pool.query(
      `UPDATE gateway_sync_items SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [pending[1]!.id],
    );
    await pool.query(`UPDATE gateway_sync_rate_limits SET active_lease_expires_at = now() - interval '1 second'`);
    expect(await items.recoverExpired()).toBe(1);
    await pool.query('UPDATE gateway_sync_rate_limits SET next_request_at = now()');
    await sync.reconcileGroup(pending[1]!.id);

    expect((openwa.getGroup as ReturnType<typeof vi.fn>).mock.calls.map(call => call[1]))
      .toEqual([ids[0], ids[1]]);
    expect(await gateway.findSyncRun(run.id)).toMatchObject({ status: 'COMPLETED', groupsSynced: 2 });
  });

  it('does not rewrite an unchanged member collection', async () => {
    const openwa = new OpenWAClient();
    await gateway.upsertSession(await openwa.getSession(INTEGRATION_SESSION_ID));
    const detail = await openwa.getGroup(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID);
    await gateway.upsertGroupDetails(INTEGRATION_SESSION_ID, detail);
    const before = await pool.query<{ ctid: string }>(
      `SELECT ctid::text FROM group_members WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );

    await gateway.upsertGroupDetails(INTEGRATION_SESSION_ID, {
      ...detail,
      participants: [...detail.participants].reverse(),
    });
    const after = await pool.query<{ ctid: string }>(
      `SELECT ctid::text FROM group_members WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('allows only one in-flight group-detail request per session', async () => {
    const session = await new OpenWAClient().getSession(INTEGRATION_SESSION_ID);
    const ids = ['paced-1@g.us', 'paced-2@g.us'];
    const openwa = {
      assertCompatibleRelease: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockResolvedValue(session),
      listGroups: vi.fn().mockResolvedValue(ids.map(id => ({ id, name: id }))),
      getGroup: vi.fn(),
    } as unknown as OpenWAClient;
    const sync = new GatewaySyncService(gateway, items, openwa);
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);
    await sync.perform(run.id);
    const pending = await listRunItems(run.id);
    expect(await items.listDispatchable(10)).toHaveLength(1);

    const claims = await Promise.all(pending.map(item => items.claim(item.id)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.sessionId).toBe(INTEGRATION_SESSION_ID);
  });

  it('enforces sync-item session isolation in PostgreSQL', async () => {
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);
    await expect(pool.query(
      `INSERT INTO gateway_sync_items (sync_run_id, session_id, group_id, ordinal, reason)
       VALUES ($1, $2, $3, 0, 'FULL')`,
      [run.id, '00000000-0000-4000-8000-000000000099', INTEGRATION_GROUP_ID],
    )).rejects.toMatchObject({ code: '23503' });
  });

  it('skips a group that disappears without failing successful siblings', async () => {
    const session = await new OpenWAClient().getSession(INTEGRATION_SESSION_ID);
    const ids = ['present@g.us', 'disappeared@g.us'];
    const openwa = {
      assertCompatibleRelease: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockResolvedValue(session),
      listGroups: vi.fn().mockResolvedValue(ids.map(id => ({ id, name: id }))),
      getGroup: vi.fn(async (_sessionId: string, id: string) => {
        if (id === ids[1]) throw new OpenWAHttpError(404, '{}');
        return { id, name: id, participants: [] };
      }),
    } as unknown as OpenWAClient;
    const sync = new GatewaySyncService(gateway, items, openwa);
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);
    await sync.perform(run.id);
    const pending = await listRunItems(run.id);
    await sync.reconcileGroup(pending[0]!.id);
    await pool.query('UPDATE gateway_sync_rate_limits SET next_request_at = now()');
    await expect(sync.reconcileGroup(pending[1]!.id)).resolves.toEqual({ skipped: true });
    expect(await gateway.findSyncRun(run.id)).toMatchObject({
      status: 'COMPLETED', groupsSynced: 1, groupsSkipped: 1, groupsFailed: 0,
    });
  });

  it('fails only an exhausted item and preserves completed sibling progress', async () => {
    const session = await new OpenWAClient().getSession(INTEGRATION_SESSION_ID);
    const ids = ['successful@g.us', 'malformed@g.us'];
    const openwa = {
      assertCompatibleRelease: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockResolvedValue(session),
      listGroups: vi.fn().mockResolvedValue(ids.map(id => ({ id, name: id }))),
      getGroup: vi.fn(async (_sessionId: string, id: string) => {
        if (id === ids[1]) throw new Error('non-retryable schema failure');
        return { id, name: id, participants: [] };
      }),
    } as unknown as OpenWAClient;
    const sync = new GatewaySyncService(gateway, items, openwa);
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);
    await sync.perform(run.id);
    const pending = await listRunItems(run.id);
    await sync.reconcileGroup(pending[0]!.id);
    await pool.query('UPDATE gateway_sync_rate_limits SET next_request_at = now()');
    const claim = await items.claim(pending[1]!.id);
    expect(claim).not.toBeNull();
    await items.fail(claim!.id, claim!.leaseToken, 'schema failure', false);
    expect(await gateway.findSyncRun(run.id)).toMatchObject({
      status: 'FAILED', groupsSynced: 1, groupsFailed: 1, membersSynced: 0,
    });
  });
});
