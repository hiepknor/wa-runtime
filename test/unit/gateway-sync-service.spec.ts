import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenWAClient } from '../../src/integrations/openwa/openwa.client';
import type { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import type { GatewaySyncItemRepository } from '../../src/modules/gateway/gateway-sync-item.repository';
import { GatewaySyncService } from '../../src/modules/gateway/gateway-sync.service';

describe('GatewaySyncService item ownership', () => {
  afterEach(() => vi.useRealTimers());

  it('renews a long-running item and stops after ownership is lost', async () => {
    vi.useFakeTimers();
    Object.assign(process.env, {
      DATABASE_URL: 'postgresql://runtime:runtime@localhost:5432/runtime',
      REDIS_URL: 'redis://localhost:6379',
      RUNTIME_API_KEY: 'runtime-key-000000000000000000000',
      OPENWA_BASE_URL: 'http://localhost:3000',
      OPENWA_API_KEY: 'openwa-key',
      OPENWA_WEBHOOK_SECRET: 'webhook-secret-0000000000000000000',
      OPENWA_ALLOWED_SESSION_IDS: '00000000-0000-4000-8000-000000000001',
    });
    const repository = { upsertGroupDetails: vi.fn() } as unknown as GatewayRepository;
    const items = {
      claim: vi.fn().mockResolvedValue({
        id: 'item-1', syncRunId: 'run-1', sessionId: 'session-1', groupId: 'group-1',
        syncEpoch: '1', leaseToken: 'lease-1', attemptNumber: 1, observedSummaryFingerprint: 'fingerprint',
      }),
      renewLease: vi.fn().mockResolvedValue(false),
    } as unknown as GatewaySyncItemRepository;
    let releaseGroup!: (group: { id: string; name: string; participants: [] }) => void;
    const openwa = {
      getGroup: vi.fn().mockImplementation(() => new Promise(resolve => { releaseGroup = resolve; })),
    } as unknown as OpenWAClient;
    const operation = new GatewaySyncService(
      repository, items, openwa, {} as never, {} as never,
    ).reconcileGroup('item-1');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(items.renewLease).toHaveBeenCalledTimes(1);
    releaseGroup({ id: 'group-1', name: 'Group', participants: [] });
    await expect(operation).resolves.toEqual({ skipped: true });
    expect(repository.upsertGroupDetails).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(items.renewLease).toHaveBeenCalledTimes(1);
  });
});
