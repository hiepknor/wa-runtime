import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayWakeCoordinator } from '../../src/modules/orchestration/gateway-work-listener.service';

describe('GatewayWakeCoordinator', () => {
  afterEach(() => vi.restoreAllMocks());

  it('allows only one scan in flight and performs one catch-up scan for a burst', async () => {
    let release!: () => void;
    const firstScan = new Promise<void>(resolve => { release = resolve; });
    const wake = vi.fn()
      .mockImplementationOnce(() => firstScan)
      .mockResolvedValue(undefined);
    const failed = vi.fn();
    const coordinator = new GatewayWakeCoordinator(wake, failed);
    coordinator.request();
    coordinator.request();
    coordinator.request();
    expect(wake).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2));
    expect(failed).not.toHaveBeenCalled();
  });
});
