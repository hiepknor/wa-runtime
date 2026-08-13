import { describe, expect, it, vi } from 'vitest';
import type { QueueService } from '../../src/core/queue/queue.service';
import type { GatewayGroupIntentRepository } from '../../src/modules/gateway/gateway-group-intent.repository';
import type { GatewaySyncItemRepository } from '../../src/modules/gateway/gateway-sync-item.repository';
import type { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import { GatewayDispatchTick } from '../../src/modules/orchestration/gateway-dispatch.tick';

describe('GatewayDispatchTick', () => {
  it('queues a sync item for its durable rate-limit availability time', async () => {
    const availableAt = new Date(Date.now() + 1_500);
    const gateway = {
      recoverExpiredSyncRuns: vi.fn().mockResolvedValue(0),
      recoverExpiredCapabilityRefreshes: vi.fn().mockResolvedValue(0),
      listPendingSyncRuns: vi.fn().mockResolvedValue([]),
      listGroupsNeedingCapabilityRefresh: vi.fn().mockResolvedValue([]),
    } as unknown as GatewayRepository;
    const syncItems = {
      recoverExpired: vi.fn().mockResolvedValue(0),
      listDispatchable: vi.fn().mockResolvedValue([{
        id: 'item-1', syncRunId: 'run-1', sessionId: 'session-1', groupId: 'group-1', availableAt,
      }]),
    } as unknown as GatewaySyncItemRepository;
    const intents = {
      recoverExpired: vi.fn().mockResolvedValue(0), listDispatchable: vi.fn().mockResolvedValue([]),
    } as unknown as GatewayGroupIntentRepository;
    const add = vi.fn().mockResolvedValue(undefined);
    const queues = { gatewaySync: { add } } as unknown as QueueService;

    await new GatewayDispatchTick(gateway, syncItems, intents, queues).run();

    expect(add).toHaveBeenCalledWith(
      'reconcile-session-group',
      expect.objectContaining({ itemId: 'item-1' }),
      expect.objectContaining({ delay: expect.any(Number) }),
    );
    const delay = add.mock.calls[0]![2].delay as number;
    expect(delay).toBeGreaterThan(1_000);
    expect(delay).toBeLessThanOrEqual(1_500);
  });

  it('coalesces overlapping wake-ups and performs one follow-up durable scan', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const gateway = {
      recoverExpiredSyncRuns: vi.fn().mockImplementationOnce(() => blocked).mockResolvedValue(0),
      recoverExpiredCapabilityRefreshes: vi.fn().mockResolvedValue(0),
      listPendingSyncRuns: vi.fn().mockResolvedValue([]),
      listGroupsNeedingCapabilityRefresh: vi.fn().mockResolvedValue([]),
    } as unknown as GatewayRepository;
    const syncItems = {
      recoverExpired: vi.fn().mockResolvedValue(0), listDispatchable: vi.fn().mockResolvedValue([]),
    } as unknown as GatewaySyncItemRepository;
    const intents = {
      recoverExpired: vi.fn().mockResolvedValue(0), listDispatchable: vi.fn().mockResolvedValue([]),
    } as unknown as GatewayGroupIntentRepository;
    const tick = new GatewayDispatchTick(gateway, syncItems, intents, {} as QueueService);

    const first = tick.run();
    const second = tick.run();
    const third = tick.run();
    expect(gateway.recoverExpiredSyncRuns).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second, third]);
    expect(gateway.recoverExpiredSyncRuns).toHaveBeenCalledTimes(2);
    expect(intents.listDispatchable).toHaveBeenCalledTimes(2);
  });
});
