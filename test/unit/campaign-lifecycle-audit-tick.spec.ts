import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CampaignLifecycleAuditTick } from '../../src/modules/orchestration/campaign-lifecycle-audit.tick';

describe('CampaignLifecycleAuditTick', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits one aggregate warning only when lifecycle drift exists', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const runs = {
      auditLifecycle: vi.fn().mockResolvedValue({
        draftWithLive: 1,
        activeWithoutNonTerminalLive: 0,
        pausedWithoutPausedOrBlockedLive: 0,
        archivedWithNonTerminalLive: 0,
        multipleLive: 0,
      }),
    };
    await new CampaignLifecycleAuditTick(runs as never).run();
    expect(warn).toHaveBeenCalledWith({
      event: 'campaign.lifecycle.drift_detected',
      count: 1,
      draftWithLive: 1,
      activeWithoutNonTerminalLive: 0,
      pausedWithoutPausedOrBlockedLive: 0,
      archivedWithNonTerminalLive: 0,
      multipleLive: 0,
    });
  });

  it('stays quiet when all lifecycle invariants hold', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const zero = {
      draftWithLive: 0,
      activeWithoutNonTerminalLive: 0,
      pausedWithoutPausedOrBlockedLive: 0,
      archivedWithNonTerminalLive: 0,
      multipleLive: 0,
    };
    await new CampaignLifecycleAuditTick({ auditLifecycle: vi.fn().mockResolvedValue(zero) } as never).run();
    expect(warn).not.toHaveBeenCalled();
  });
});
