import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { OpenWAClient, OpenWAHttpError, pendingGroupName } from '../../src/integrations/openwa/openwa.client';
import { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import { GatewaySyncService } from '../../src/modules/gateway/gateway-sync.service';
import { GatewaySyncItemRepository } from '../../src/modules/gateway/gateway-sync-item.repository';
import { GatewayGroupIntentRepository } from '../../src/modules/gateway/gateway-group-intent.repository';
import { GatewaySyncRateLimitRepository } from '../../src/modules/gateway/gateway-sync-rate-limit.repository';
import { GatewaySyncMode } from '../../src/contracts/sessions/sync-request.dto';
import { ContactRepository } from '../../src/modules/contacts/contact.repository';
import {
  INTEGRATION_GROUP_ID,
  INTEGRATION_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
  seedSendableGroup,
} from '../support/integration-database';

describe('gateway sync recovery', () => {
  let pool: Pool;
  let database: DatabaseService;
  let gateway: GatewayRepository;
  let items: GatewaySyncItemRepository;
  let groupIntents: GatewayGroupIntentRepository;

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
    gateway = new GatewayRepository(database, new ContactRepository(database));
    items = new GatewaySyncItemRepository(database);
    groupIntents = new GatewayGroupIntentRepository(database);
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

    const sync = new GatewaySyncService(gateway, items, new OpenWAClient(), groupIntents, {} as never);
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
    const sync = new GatewaySyncService(gateway, items, openwa, groupIntents, {} as never);
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
    const sync = new GatewaySyncService(gateway, items, openwa, groupIntents, {} as never);
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);

    await sync.perform(run.id);
    expect(await gateway.findSyncRun(run.id)).toMatchObject({
      status: 'RUNNING', phase: 'RECONCILING', groupsDiscovered: 3,
      groupsScheduled: 3, groupsSynced: 0, groupsPending: 3,
      groupsRunning: 0, groupsRetrying: 0, membersSynced: 0,
    });
    expect(await gateway.findGroup(INTEGRATION_SESSION_ID, groupIds[2]!)).toMatchObject({
      name: groupIds[2], detailsSyncedAt: null,
    });

    const pending = await listRunItems(run.id);
    await sync.reconcileGroup(pending[0]!.id);
    expect(await gateway.findSyncRun(run.id)).toMatchObject({
      status: 'RUNNING', groupsSynced: 1, groupsPending: 2, membersSynced: 1,
    });
    for (const item of pending.slice(1)) {
      await pool.query('UPDATE gateway_sync_rate_limits SET next_request_at = now()');
      await sync.reconcileGroup(item.id);
    }
    expect(await gateway.findSyncRun(run.id)).toMatchObject({
      status: 'COMPLETED', phase: 'COMPLETED', groupsSynced: 3, groupsFailed: 0, membersSynced: 3,
    });
  });

  it('defers a suspicious destructive snapshot until it is confirmed', async () => {
    const session = await new OpenWAClient().getSession(INTEGRATION_SESSION_ID);
    await gateway.upsertSession(session);
    const baselineGroups = Array.from({ length: 20 }, (_, index) => ({
      id: `baseline-${index}@g.us`, name: `Baseline ${index}`,
    }));
    const baseline = await gateway.createSyncRun(INTEGRATION_SESSION_ID);
    const baselineClaim = await gateway.claimSyncRun(baseline.id);
    await items.publishDiscovery({
      syncRunId: baseline.id, leaseToken: baselineClaim!.leaseToken, syncEpoch: baselineClaim!.syncEpoch,
    }, INTEGRATION_SESSION_ID, GatewaySyncMode.FULL, baselineGroups);
    await pool.query(
      `UPDATE gateway_sync_items SET status = 'COMPLETED', completed_at = now()
       WHERE sync_run_id = $1`,
      [baseline.id],
    );
    await pool.query(
      `UPDATE sync_runs SET status = 'COMPLETED', phase = 'COMPLETED', completed_at = now()
       WHERE id = $1`,
      [baseline.id],
    );

    const suspiciousGroups = [{ id: baselineGroups[0]!.id, name: baselineGroups[0]!.name }];
    const first = await gateway.createSyncRun(INTEGRATION_SESSION_ID);
    const firstClaim = await gateway.claimSyncRun(first.id);
    const deferred = await items.publishDiscovery({
      syncRunId: first.id, leaseToken: firstClaim!.leaseToken, syncEpoch: firstClaim!.syncEpoch,
    }, INTEGRATION_SESSION_ID, GatewaySyncMode.FULL, suspiciousGroups);
    expect(deferred.deferred).toBe(true);
    expect(await gateway.findSyncRun(first.id)).toMatchObject({ status: 'PENDING', nextAttemptAt: expect.any(Date) });
    const deferredAttempt = await pool.query<{ attempt_count: number }>(
      `SELECT attempt_count FROM sync_runs WHERE id = $1`, [first.id],
    );
    expect(deferredAttempt.rows[0]?.attempt_count).toBe(0);
    const activeAfterFirst = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM gateway_groups WHERE session_id = $1 AND is_active = true`,
      [INTEGRATION_SESSION_ID],
    );
    expect(activeAfterFirst.rows[0]?.count).toBe('20');

    await pool.query(`UPDATE sync_runs SET next_attempt_at = now() WHERE id = $1`, [first.id]);
    const confirmationClaim = await gateway.claimSyncRun(first.id);
    const confirmed = await items.publishDiscovery({
      syncRunId: first.id, leaseToken: confirmationClaim!.leaseToken, syncEpoch: confirmationClaim!.syncEpoch,
    }, INTEGRATION_SESSION_ID, GatewaySyncMode.FULL, suspiciousGroups);
    expect(confirmed.deferred).toBe(false);
    const activeAfterConfirmation = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM gateway_groups WHERE session_id = $1 AND is_active = true`,
      [INTEGRATION_SESSION_ID],
    );
    expect(activeAfterConfirmation.rows[0]?.count).toBe('1');
  });

  it('accepts an empty authoritative snapshot for a new session', async () => {
    await gateway.upsertSession(await new OpenWAClient().getSession(INTEGRATION_SESSION_ID));
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);
    const claim = await gateway.claimSyncRun(run.id);
    const result = await items.publishDiscovery({
      syncRunId: run.id, leaseToken: claim!.leaseToken, syncEpoch: claim!.syncEpoch,
    }, INTEGRATION_SESSION_ID, GatewaySyncMode.FULL, []);
    expect(result).toMatchObject({ discovered: 0, scheduled: 0, completed: true, deferred: false });
    expect(await gateway.findSyncRun(run.id)).toMatchObject({ status: 'COMPLETED' });
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

  it('keeps a changed summary dirty after terminal reconciliation failure', async () => {
    const openwa = new OpenWAClient();
    await gateway.upsertSession(await openwa.getSession(INTEGRATION_SESSION_ID));
    const summaries = await openwa.listGroups(INTEGRATION_SESSION_ID);
    const detail = await openwa.getGroup(INTEGRATION_SESSION_ID, summaries[0]!.id);
    await gateway.upsertGroupDetails(INTEGRATION_SESSION_ID, detail);

    const warmup = await gateway.createSyncRun(INTEGRATION_SESSION_ID, GatewaySyncMode.INCREMENTAL);
    const warmupClaim = await gateway.claimSyncRun(warmup.id);
    await items.publishDiscovery({
      syncRunId: warmup.id, leaseToken: warmupClaim!.leaseToken, syncEpoch: warmupClaim!.syncEpoch,
    }, INTEGRATION_SESSION_ID, GatewaySyncMode.INCREMENTAL, summaries);
    const warmupItem = (await listRunItems(warmup.id))[0]!;
    const claimedWarmup = await items.claim(warmupItem.id);
    await items.complete(claimedWarmup!.id, claimedWarmup!.leaseToken, detail.participants.length);

    const changed = [{ ...summaries[0]!, name: 'Changed summary' }];
    const failedRun = await gateway.createSyncRun(INTEGRATION_SESSION_ID, GatewaySyncMode.INCREMENTAL);
    const failedClaim = await gateway.claimSyncRun(failedRun.id);
    await items.publishDiscovery({
      syncRunId: failedRun.id, leaseToken: failedClaim!.leaseToken, syncEpoch: failedClaim!.syncEpoch,
    }, INTEGRATION_SESSION_ID, GatewaySyncMode.INCREMENTAL, changed);
    const failedItem = (await listRunItems(failedRun.id))[0]!;
    await pool.query('UPDATE gateway_sync_rate_limits SET next_request_at = now()');
    const claimedFailed = await items.claim(failedItem.id);
    await items.fail(claimedFailed!.id, claimedFailed!.leaseToken, 'terminal failure', {
      retryable: false, ratePressure: false, code: 'TEST_FAILURE',
    });

    const retryRun = await gateway.createSyncRun(INTEGRATION_SESSION_ID, GatewaySyncMode.INCREMENTAL);
    const retryClaim = await gateway.claimSyncRun(retryRun.id);
    await items.publishDiscovery({
      syncRunId: retryRun.id, leaseToken: retryClaim!.leaseToken, syncEpoch: retryClaim!.syncEpoch,
    }, INTEGRATION_SESSION_ID, GatewaySyncMode.INCREMENTAL, changed);
    expect(await gateway.findSyncRun(retryRun.id)).toMatchObject({
      status: 'RUNNING', groupsScheduled: 1,
    });

    const retryItem = (await listRunItems(retryRun.id))[0]!;
    await pool.query('UPDATE gateway_sync_rate_limits SET next_request_at = now(), cooldown_until = NULL');
    const claimedRetry = await items.claim(retryItem.id);
    await items.complete(claimedRetry!.id, claimedRetry!.leaseToken, detail.participants.length);
    const cleanRun = await gateway.createSyncRun(INTEGRATION_SESSION_ID, GatewaySyncMode.INCREMENTAL);
    const cleanClaim = await gateway.claimSyncRun(cleanRun.id);
    await items.publishDiscovery({
      syncRunId: cleanRun.id, leaseToken: cleanClaim!.leaseToken, syncEpoch: cleanClaim!.syncEpoch,
    }, INTEGRATION_SESSION_ID, GatewaySyncMode.INCREMENTAL, changed);
    expect(await gateway.findSyncRun(cleanRun.id)).toMatchObject({ status: 'COMPLETED', groupsScheduled: 0 });
  });

  it('does not let an older completed item reconcile a newer observed summary', async () => {
    const openwa = new OpenWAClient();
    await gateway.upsertSession(await openwa.getSession(INTEGRATION_SESSION_ID));
    const summaries = await openwa.listGroups(INTEGRATION_SESSION_ID);
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID, GatewaySyncMode.FULL);
    const runClaim = await gateway.claimSyncRun(run.id);
    await items.publishDiscovery({
      syncRunId: run.id, leaseToken: runClaim!.leaseToken, syncEpoch: runClaim!.syncEpoch,
    }, INTEGRATION_SESSION_ID, GatewaySyncMode.FULL, summaries.slice(0, 1));
    const item = (await listRunItems(run.id))[0]!;
    const itemClaim = await items.claim(item.id);

    await pool.query(
      `UPDATE gateway_groups SET summary_fingerprint = 'newer-observed-fingerprint'
       WHERE session_id = $1 AND id = $2`,
      [INTEGRATION_SESSION_ID, summaries[0]!.id],
    );
    await items.complete(itemClaim!.id, itemClaim!.leaseToken, 0);

    const fingerprints = await pool.query<{
      summary_fingerprint: string;
      reconciled_summary_fingerprint: string;
    }>(
      `SELECT summary_fingerprint, reconciled_summary_fingerprint FROM gateway_groups
       WHERE session_id = $1 AND id = $2`,
      [INTEGRATION_SESSION_ID, summaries[0]!.id],
    );
    expect(fingerprints.rows[0]!.summary_fingerprint).toBe('newer-observed-fingerprint');
    expect(fingerprints.rows[0]!.reconciled_summary_fingerprint).not.toBe('newer-observed-fingerprint');
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
    const sync = new GatewaySyncService(gateway, items, openwa, groupIntents, {} as never);
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

  it('renews item ownership and rejects renewal by a stale lease token', async () => {
    const session = await new OpenWAClient().getSession(INTEGRATION_SESSION_ID);
    const openwa = {
      assertCompatibleRelease: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockResolvedValue(session),
      listGroups: vi.fn().mockResolvedValue([{ id: 'long-running@g.us', name: 'Long running' }]),
    } as unknown as OpenWAClient;
    const sync = new GatewaySyncService(gateway, items, openwa, groupIntents, {} as never);
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);
    await sync.perform(run.id);
    const item = (await listRunItems(run.id))[0]!;
    const claim = await items.claim(item.id);
    expect(await items.renewLease(claim!.id, claim!.leaseToken)).toBe(true);
    expect(await items.renewLease(claim!.id, '00000000-0000-4000-8000-000000000099')).toBe(false);
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

  it('updates only changed members when a collection fingerprint changes', async () => {
    const openwa = new OpenWAClient();
    await gateway.upsertSession(await openwa.getSession(INTEGRATION_SESSION_ID));
    const detail = await openwa.getGroup(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID);
    const extra = {
      id: 'extra-participant', number: '84970000001', name: 'Stable member',
      isAdmin: false, isSuperAdmin: false,
    };
    await gateway.upsertGroupDetails(INTEGRATION_SESSION_ID, {
      ...detail, participants: [...detail.participants, extra],
    });
    const before = await pool.query<{ participant_id: string; ctid: string }>(
      `SELECT participant_id, ctid::text FROM group_members
       WHERE session_id = $1 AND group_id = $2 ORDER BY participant_id`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );

    await gateway.upsertGroupDetails(INTEGRATION_SESSION_ID, {
      ...detail,
      participants: [
        { ...detail.participants[0]!, name: 'Changed member' },
        extra,
      ],
    });
    const after = await pool.query<{ participant_id: string; display_name: string | null; ctid: string }>(
      `SELECT participant_id, display_name, ctid::text FROM group_members
       WHERE session_id = $1 AND group_id = $2 ORDER BY participant_id`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );

    expect(after).toMatchObject({ rowCount: 2 });
    expect(after.rows.find(row => row.participant_id === extra.id)?.ctid)
      .toBe(before.rows.find(row => row.participant_id === extra.id)?.ctid);
    expect(after.rows.find(row => row.participant_id === detail.participants[0]!.id)?.display_name)
      .toBe('Changed member');
  });

  it('links every synchronized member to a session-scoped observed contact without treating a LID as phone', async () => {
    const session = await new OpenWAClient().getSession(INTEGRATION_SESSION_ID);
    await gateway.upsertSession(session);
    const group = {
      id: INTEGRATION_GROUP_ID,
      name: 'Identity coverage',
      participants: [
        { id: 'opaque-lid@lid', number: 'opaque-lid', name: null, isAdmin: false, isSuperAdmin: false },
        { id: '628111@s.whatsapp.net', number: '628111', name: 'Named', isAdmin: false, isSuperAdmin: false },
      ],
    };
    await gateway.upsertGroupDetails(INTEGRATION_SESSION_ID, group);

    const linked = await pool.query<{
      participant_id: string;
      contact_id: string | null;
      identity_type: string;
      resolved_phone_number: string | null;
    }>(
      `SELECT participant_id, contact_id, identity_type, resolved_phone_number FROM group_members
       WHERE session_id = $1 AND group_id = $2 ORDER BY participant_id`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(linked.rows).toHaveLength(2);
    expect(linked.rows.every(row => row.contact_id !== null)).toBe(true);
    expect(linked.rows).toMatchObject([
      { participant_id: '628111@s.whatsapp.net', identity_type: 'PHONE_JID', resolved_phone_number: '628111' },
      { participant_id: 'opaque-lid@lid', identity_type: 'LID', resolved_phone_number: null },
    ]);
    const identifiers = await pool.query<{ identity_type: string; identity_value: string }>(
      `SELECT identity_type, identity_value FROM contact_identifiers
       WHERE session_id = $1 ORDER BY identity_type, identity_value`,
      [INTEGRATION_SESSION_ID],
    );
    expect(identifiers.rows).toEqual([
      { identity_type: 'LID', identity_value: 'opaque-lid@lid' },
      { identity_type: 'PHONE', identity_value: '628111' },
      { identity_type: 'PHONE_JID', identity_value: '628111@c.us' },
    ]);

    const otherSession = '00000000-0000-4000-8000-000000000002';
    await gateway.upsertSession({ ...session, id: otherSession, name: 'Other session' });
    await gateway.upsertGroupDetails(otherSession, group);
    const perSession = await pool.query<{ session_id: string; contact_id: string }>(
      `SELECT session_id, contact_id FROM contact_identifiers
       WHERE identity_type = 'LID' AND identity_value = 'opaque-lid@lid' ORDER BY session_id`,
    );
    expect(perSession.rows).toHaveLength(2);
    expect(perSession.rows[0]?.contact_id).not.toBe(perSession.rows[1]?.contact_id);
  });

  it('ingests observed contacts and materializes deterministic name precedence', async () => {
    const contacts = new ContactRepository(database);
    const session = await new OpenWAClient().getSession(INTEGRATION_SESSION_ID);
    await gateway.upsertSession(session);
    await gateway.upsertGroupDetails(INTEGRATION_SESSION_ID, {
      id: INTEGRATION_GROUP_ID,
      name: 'Enrichment',
      participants: [{
        id: '628222@c.us', number: '628222', name: 'Participant name',
        isAdmin: false, isSuperAdmin: false,
      }],
    });
    const claim = (await contacts.beginObservedSnapshot(INTEGRATION_SESSION_ID))!;
    await expect(contacts.ingestObservedPage(INTEGRATION_SESSION_ID, claim.generation, claim.leaseToken, [
      {
        id: '628222@c.us', number: '628222', name: 'Contact name', pushName: 'Push name',
        isMyContact: true, isBlocked: false,
      },
      {
        id: 'unseen@lid', number: 'unseen', name: null, pushName: 'Observed only',
        isMyContact: true, isBlocked: false,
      },
    ])).resolves.toMatchObject({ observed: 2, enriched: 1 });
    await contacts.completeObservedSnapshot(
      INTEGRATION_SESSION_ID, claim.generation, claim.leaseToken, 2, 86_400_000,
    );

    const member = await pool.query<{ display_name: string; display_name_source: string }>(
      `SELECT display_name, display_name_source FROM group_members
       WHERE session_id = $1 AND group_id = $2 AND participant_id = '628222@c.us'`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(member.rows[0]).toEqual({
      display_name: 'Contact name', display_name_source: 'OPENWA_CONTACT_NAME',
    });
    const observedOnly = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM contact_identifiers
       WHERE session_id = $1 AND identity_type = 'LID' AND identity_value = 'unseen@lid'`,
      [INTEGRATION_SESSION_ID],
    );
    expect(observedOnly.rows[0]?.count).toBe('1');
  });

  it('merges a LID and phone contact only when one OpenWA record links both identities', async () => {
    const contacts = new ContactRepository(database);
    const session = await new OpenWAClient().getSession(INTEGRATION_SESSION_ID);
    await gateway.upsertSession(session);
    await gateway.upsertGroupDetails(INTEGRATION_SESSION_ID, {
      id: INTEGRATION_GROUP_ID,
      name: 'Identity merge',
      participants: [
        { id: 'linked@lid', number: 'linked', name: null, isAdmin: false, isSuperAdmin: false },
        { id: '628333@c.us', number: '628333', name: null, isAdmin: false, isSuperAdmin: false },
      ],
    });

    const claim = (await contacts.beginObservedSnapshot(INTEGRATION_SESSION_ID))!;
    await expect(contacts.ingestObservedPage(INTEGRATION_SESSION_ID, claim.generation, claim.leaseToken, [{
      id: 'linked@lid', number: '628333', name: 'Authoritative contact', pushName: null,
      isMyContact: true, isBlocked: false,
    }])).resolves.toMatchObject({ observed: 1, enriched: 1 });
    await expect(contacts.reconcileObservedIdentities(INTEGRATION_SESSION_ID, claim.generation, claim.leaseToken))
      .resolves.toMatchObject({ enriched: 1, merged: 1, conflicts: 0 });

    const identifiers = await pool.query<{ identity_type: string; contact_id: string }>(
      `SELECT identity_type, contact_id FROM contact_identifiers
       WHERE session_id = $1 AND identity_value IN ('linked@lid', '628333', '628333@c.us')
       ORDER BY identity_type`,
      [INTEGRATION_SESSION_ID],
    );
    expect(new Set(identifiers.rows.map(row => row.contact_id)).size).toBe(1);
    const members = await pool.query<{ contact_id: string; display_name: string }>(
      `SELECT contact_id, display_name FROM group_members
       WHERE session_id = $1 AND group_id = $2 ORDER BY participant_id`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(new Set(members.rows.map(row => row.contact_id)).size).toBe(1);
    expect(members.rows.map(row => row.display_name)).toEqual([
      'Authoritative contact', 'Authoritative contact',
    ]);
  });

  it('keeps identities separate when one phone is claimed by multiple LIDs across pages', async () => {
    const contacts = new ContactRepository(database);
    const session = await new OpenWAClient().getSession(INTEGRATION_SESSION_ID);
    await gateway.upsertSession(session);
    await gateway.upsertGroupDetails(INTEGRATION_SESSION_ID, {
      id: INTEGRATION_GROUP_ID,
      name: 'Ambiguous identity',
      participants: [
        { id: 'first@lid', number: 'first', name: null, isAdmin: false, isSuperAdmin: false },
        { id: 'second@lid', number: 'second', name: null, isAdmin: false, isSuperAdmin: false },
        { id: '628444@c.us', number: '628444', name: null, isAdmin: false, isSuperAdmin: false },
      ],
    });

    const claim = (await contacts.beginObservedSnapshot(INTEGRATION_SESSION_ID))!;
    await expect(contacts.ingestObservedPage(INTEGRATION_SESSION_ID, claim.generation, claim.leaseToken, [{
      id: 'first@lid', number: '628444', name: 'First', pushName: null,
      isMyContact: true, isBlocked: false,
    }])).resolves.toMatchObject({ observed: 1, enriched: 1 });
    await expect(contacts.ingestObservedPage(INTEGRATION_SESSION_ID, claim.generation, claim.leaseToken, [{
      id: 'second@lid', number: '628444', name: 'Second', pushName: null,
      isMyContact: true, isBlocked: false,
    }])).resolves.toMatchObject({ observed: 1, enriched: 1 });
    await expect(contacts.reconcileObservedIdentities(INTEGRATION_SESSION_ID, claim.generation, claim.leaseToken))
      .resolves.toMatchObject({ enriched: 0, merged: 0, conflicts: 2 });

    const identities = await pool.query<{ contact_id: string }>(
      `SELECT DISTINCT contact_id FROM contact_identifiers
       WHERE session_id = $1 AND identity_value IN ('first@lid', 'second@lid', '628444')`,
      [INTEGRATION_SESSION_ID],
    );
    expect(identities.rows).toHaveLength(3);
  });

  it('fences concurrent and stale contact snapshot attempts per session', async () => {
    const contacts = new ContactRepository(database);
    const session = await new OpenWAClient().getSession(INTEGRATION_SESSION_ID);
    await gateway.upsertSession(session);
    const first = await contacts.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    expect(first).not.toBeNull();
    await expect(contacts.beginObservedSnapshot(INTEGRATION_SESSION_ID)).resolves.toBeNull();
    await pool.query(
      `UPDATE contact_sync_state SET lease_expires_at = now() - interval '1 second' WHERE session_id = $1`,
      [INTEGRATION_SESSION_ID],
    );
    const current = await contacts.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    expect(current?.generation).toBe(first!.generation + 1);

    await expect(contacts.ingestObservedPage(
      INTEGRATION_SESSION_ID,
      first!.generation,
      first!.leaseToken,
      [{
        id: 'stale@lid', number: 'stale', name: null, pushName: null,
        isMyContact: false, isBlocked: false,
      }],
    )).rejects.toThrow('lost write ownership');
    await contacts.failObservedSnapshot(
      INTEGRATION_SESSION_ID, current!.generation, current!.leaseToken, 'UPSTREAM_ERROR',
    );
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
    const sync = new GatewaySyncService(gateway, items, openwa, groupIntents, {} as never);
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);
    await sync.perform(run.id);
    const pending = await listRunItems(run.id);
    expect(await items.listDispatchable(10)).toHaveLength(1);

    const claims = await Promise.all(pending.map(item => items.claim(item.id)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.sessionId).toBe(INTEGRATION_SESSION_ID);
  });

  it('exposes the next durable rate-limit time for delayed dispatch', async () => {
    const session = await new OpenWAClient().getSession(INTEGRATION_SESSION_ID);
    const ids = ['delayed-1@g.us', 'delayed-2@g.us'];
    const openwa = {
      assertCompatibleRelease: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockResolvedValue(session),
      listGroups: vi.fn().mockResolvedValue(ids.map(id => ({ id, name: id }))),
      getGroup: vi.fn(),
    } as unknown as OpenWAClient;
    const sync = new GatewaySyncService(gateway, items, openwa, groupIntents, {} as never);
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);
    await sync.perform(run.id);
    const first = (await items.listDispatchable(10))[0]!;
    const claim = await items.claim(first.id);
    expect(claim).not.toBeNull();
    await items.recordSessionRequestOutcome(INTEGRATION_SESSION_ID, claim!.leaseToken, true);

    const next = (await items.listDispatchable(10))[0]!;
    expect(next.groupId).not.toBe(first.groupId);
    expect(next.availableAt.valueOf()).toBeGreaterThan(Date.now());
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
    const sync = new GatewaySyncService(gateway, items, openwa, groupIntents, {} as never);
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
    const sync = new GatewaySyncService(gateway, items, openwa, groupIntents, {} as never);
    const run = await gateway.createSyncRun(INTEGRATION_SESSION_ID);
    await sync.perform(run.id);
    const pending = await listRunItems(run.id);
    await sync.reconcileGroup(pending[0]!.id);
    await pool.query('UPDATE gateway_sync_rate_limits SET next_request_at = now()');
    const claim = await items.claim(pending[1]!.id);
    expect(claim).not.toBeNull();
    await items.fail(claim!.id, claim!.leaseToken, 'schema failure', {
      retryable: false, ratePressure: false, code: 'INVALID_RESPONSE',
    });
    expect(await gateway.findSyncRun(run.id)).toMatchObject({
      status: 'FAILED', groupsSynced: 1, groupsFailed: 1, membersSynced: 0,
    });
  });

  it('applies session cooldown only for upstream rate pressure', async () => {
    await seedSendableGroup(pool);
    await pool.query(`INSERT INTO gateway_sync_rate_limits (session_id) VALUES ($1)`, [INTEGRATION_SESSION_ID]);
    const noPressureLease = await items.reserveSessionRequest(INTEGRATION_SESSION_ID);
    expect(noPressureLease).not.toBeNull();
    await items.recordSessionRequestOutcome(INTEGRATION_SESSION_ID, noPressureLease!, false, false);
    const withoutPressure = await pool.query<{ consecutive_failures: number; cooldown_until: Date | null }>(
      `SELECT consecutive_failures, cooldown_until FROM gateway_sync_rate_limits WHERE session_id = $1`,
      [INTEGRATION_SESSION_ID],
    );
    expect(withoutPressure.rows[0]).toMatchObject({ consecutive_failures: 0, cooldown_until: null });

    await pool.query(`UPDATE gateway_sync_rate_limits SET next_request_at = now() WHERE session_id = $1`, [INTEGRATION_SESSION_ID]);
    const pressureLease = await items.reserveSessionRequest(INTEGRATION_SESSION_ID);
    await items.recordSessionRequestOutcome(INTEGRATION_SESSION_ID, pressureLease!, false, true);
    const withPressure = await pool.query<{ consecutive_failures: number; cooldown_until: Date | null }>(
      `SELECT consecutive_failures, cooldown_until FROM gateway_sync_rate_limits WHERE session_id = $1`,
      [INTEGRATION_SESSION_ID],
    );
    expect(withPressure.rows[0]?.consecutive_failures).toBe(1);
    expect(withPressure.rows[0]?.cooldown_until).toBeInstanceOf(Date);
  });

  it('persists adaptive rate reduction on 429 and recovers it after successful reads', async () => {
    await seedSendableGroup(pool);
    const rateLimits = new GatewaySyncRateLimitRepository(database);
    const firstLease = await rateLimits.reserve(INTEGRATION_SESSION_ID);
    expect(firstLease).not.toBeNull();
    await rateLimits.record(INTEGRATION_SESSION_ID, firstLease!, {
      retryable: true, ratePressure: true, reduceRate: true, code: 'RATE_LIMITED',
    });
    let state = await pool.query<{
      effective_requests_per_minute: number; success_streak: number; last_rate_pressure_at: Date | null;
    }>(
      `SELECT effective_requests_per_minute, success_streak, last_rate_pressure_at
       FROM gateway_sync_rate_limits WHERE session_id = $1`,
      [INTEGRATION_SESSION_ID],
    );
    expect(state.rows[0]).toMatchObject({ effective_requests_per_minute: 20, success_streak: 0 });
    expect(state.rows[0]!.last_rate_pressure_at).toBeInstanceOf(Date);

    for (let success = 0; success < 2; success += 1) {
      await pool.query(
        `UPDATE gateway_sync_rate_limits SET next_request_at = now(), cooldown_until = NULL
         WHERE session_id = $1`,
        [INTEGRATION_SESSION_ID],
      );
      const lease = await rateLimits.reserve(INTEGRATION_SESSION_ID);
      expect(lease).not.toBeNull();
      await rateLimits.record(INTEGRATION_SESSION_ID, lease!);
    }
    state = await pool.query(
      `SELECT effective_requests_per_minute, success_streak, last_rate_pressure_at
       FROM gateway_sync_rate_limits WHERE session_id = $1`,
      [INTEGRATION_SESSION_ID],
    );
    expect(state.rows[0]).toMatchObject({ effective_requests_per_minute: 21, success_streak: 0 });
  });
});
