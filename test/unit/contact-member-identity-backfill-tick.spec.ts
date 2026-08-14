import { describe, expect, it, vi } from 'vitest';
import type { ContactMemberIdentityBackfillRepository } from '../../src/modules/contacts/contact-member-identity-backfill.repository';
import { ContactMemberIdentityBackfillTick } from '../../src/modules/contacts/contact-member-identity-backfill.tick';

describe('ContactMemberIdentityBackfillTick', () => {
  it('does not claim work while disabled', async () => {
    const repository = { claim: vi.fn() };
    await new ContactMemberIdentityBackfillTick(
      repository as unknown as ContactMemberIdentityBackfillRepository,
      { enabled: false, batchSize: 1000, maxBatchesPerTick: 20 },
    ).run();
    expect(repository.claim).not.toHaveBeenCalled();
  });

  it('processes bounded batches until completion', async () => {
    const repository = {
      claim: vi.fn().mockResolvedValue('lease-1'),
      processBatch: vi.fn()
        .mockResolvedValueOnce({ updated: 1000, completed: false, lostOwnership: false })
        .mockResolvedValueOnce({ updated: 25, completed: true, lostOwnership: false }),
      fail: vi.fn(),
      release: vi.fn(),
    };
    await new ContactMemberIdentityBackfillTick(
      repository as unknown as ContactMemberIdentityBackfillRepository,
      { enabled: true, batchSize: 1000, maxBatchesPerTick: 20 },
    ).run();
    expect(repository.processBatch).toHaveBeenCalledTimes(2);
    expect(repository.processBatch).toHaveBeenCalledWith('lease-1', 1000);
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it('stops without mutating state after losing ownership', async () => {
    const repository = {
      claim: vi.fn().mockResolvedValue('stale-lease'),
      processBatch: vi.fn().mockResolvedValue({ updated: 0, completed: false, lostOwnership: true }),
      fail: vi.fn(),
      release: vi.fn(),
    };
    await new ContactMemberIdentityBackfillTick(
      repository as unknown as ContactMemberIdentityBackfillRepository,
      { enabled: true, batchSize: 1000, maxBatchesPerTick: 20 },
    ).run();
    expect(repository.processBatch).toHaveBeenCalledTimes(1);
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it('records a generic retry code and rethrows batch failures', async () => {
    const error = new Error('database unavailable');
    const repository = {
      claim: vi.fn().mockResolvedValue('lease-1'),
      processBatch: vi.fn().mockRejectedValue(error),
      fail: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    const tick = new ContactMemberIdentityBackfillTick(
      repository as unknown as ContactMemberIdentityBackfillRepository,
      { enabled: true, batchSize: 1000, maxBatchesPerTick: 20 },
    );
    await expect(tick.run()).rejects.toBe(error);
    expect(repository.fail).toHaveBeenCalledWith('lease-1', 'BACKFILL_ERROR');
  });

  it('cooperatively releases bounded unfinished work for the next tick', async () => {
    const repository = {
      claim: vi.fn().mockResolvedValue('lease-1'),
      processBatch: vi.fn().mockResolvedValue({ updated: 1000, completed: false, lostOwnership: false }),
      release: vi.fn().mockResolvedValue(true),
      fail: vi.fn(),
    };
    await new ContactMemberIdentityBackfillTick(
      repository as unknown as ContactMemberIdentityBackfillRepository,
      { enabled: true, batchSize: 1000, maxBatchesPerTick: 2 },
    ).run();
    expect(repository.processBatch).toHaveBeenCalledTimes(2);
    expect(repository.release).toHaveBeenCalledWith('lease-1');
  });
});
