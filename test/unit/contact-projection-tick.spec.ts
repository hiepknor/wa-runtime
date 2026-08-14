import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactProjectionRepository } from '../../src/modules/contacts/contact-projection.repository';
import { ContactProjectionTick } from '../../src/modules/contacts/contact-projection.tick';

describe('ContactProjectionTick', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  const options = {
    enabled: true,
    batchSize: 100,
    maxJobsPerTick: 1,
    maxBatchesPerJob: 2,
  };

  it('does not claim work while disabled', async () => {
    const repository = { claim: vi.fn() } as unknown as ContactProjectionRepository;
    await new ContactProjectionTick(repository, { ...options, enabled: false }).run();
    expect(repository.claim).not.toHaveBeenCalled();
  });

  it('bounds batches and releases unfinished work', async () => {
    const claim = { sessionId: 'session', identityId: 'identity', leaseToken: 'lease' };
    const repository = {
      claim: vi.fn().mockResolvedValue(claim),
      projectBatch: vi.fn().mockResolvedValue({ updated: 100, completed: false }),
      release: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn(),
    } as unknown as ContactProjectionRepository;
    await new ContactProjectionTick(repository, options).run();
    expect(repository.projectBatch).toHaveBeenCalledTimes(2);
    expect(repository.release).toHaveBeenCalledWith(claim);
  });

  it('records a generic failure without logging identity data', async () => {
    const claim = { sessionId: 'private-session', identityId: 'private-id', leaseToken: 'private-lease' };
    const repository = {
      claim: vi.fn().mockResolvedValue(claim),
      projectBatch: vi.fn().mockRejectedValue(new Error('projection failed')),
      release: vi.fn(),
      fail: vi.fn().mockResolvedValue(undefined),
    } as unknown as ContactProjectionRepository;
    const warning = vi.spyOn(Logger.prototype, 'warn');
    await expect(new ContactProjectionTick(repository, options).run()).rejects.toThrow('projection failed');
    expect(repository.fail).toHaveBeenCalledWith(claim);
    expect(warning).toHaveBeenCalledWith({ event: 'contacts.projection.failed' });
  });
});
