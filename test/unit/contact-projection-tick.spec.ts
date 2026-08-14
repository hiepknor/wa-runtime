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
    bootstrapBatchSize: 1_000,
    evidenceBackfillEnabled: true,
    evidenceBackfillBatchSize: 2_000,
  };

  it('does not claim work while disabled', async () => {
    const repository = {
      backfillEvidence: vi.fn(), enqueueBootstrap: vi.fn(),
      coalesceResolvedAliases: vi.fn(), catchUpMissingEvidence: vi.fn(),
      catchUpUnprojected: vi.fn(), claim: vi.fn(),
    } as unknown as ContactProjectionRepository;
    await new ContactProjectionTick(repository, { ...options, enabled: false }).run();
    expect(repository.enqueueBootstrap).not.toHaveBeenCalled();
    expect(repository.backfillEvidence).not.toHaveBeenCalled();
    expect(repository.claim).not.toHaveBeenCalled();
  });

  it('bounds batches and releases unfinished work', async () => {
    const claim = { sessionId: 'session', identityId: 'identity', leaseToken: 'lease' };
    const repository = {
      enqueueBootstrap: vi.fn().mockResolvedValue(1),
      coalesceResolvedAliases: vi.fn().mockResolvedValue(0),
      catchUpMissingEvidence: vi.fn().mockResolvedValue(0),
      catchUpUnprojected: vi.fn().mockResolvedValue(0),
      backfillEvidence: vi.fn().mockResolvedValue(2_000),
      claim: vi.fn().mockResolvedValue(claim),
      projectBatch: vi.fn().mockResolvedValue({ updated: 100, completed: false }),
      release: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn(),
      getQueueMetrics: vi.fn().mockResolvedValue({
        pending: 1, inactivePending: 0, failed: 0, oldestLagSeconds: 2,
      }),
    } as unknown as ContactProjectionRepository;
    await new ContactProjectionTick(repository, options).run();
    expect(repository.enqueueBootstrap).toHaveBeenCalledWith(1_000);
    expect(repository.coalesceResolvedAliases).toHaveBeenCalledWith(1_000);
    expect(repository.catchUpMissingEvidence).toHaveBeenCalledWith(1_000);
    expect(repository.catchUpUnprojected).toHaveBeenCalledWith(1_000);
    expect(repository.backfillEvidence).toHaveBeenCalledWith(2_000);
    expect(repository.projectBatch).toHaveBeenCalledTimes(2);
    expect(repository.release).toHaveBeenCalledWith(claim);
    expect(repository.getQueueMetrics).toHaveBeenCalledOnce();
    expect(Logger.prototype.log).toHaveBeenCalledWith({
      event: 'contacts.projection.completed',
      updated: 200,
      completed: 0,
      pending: 1,
      inactivePending: 0,
      failed: 0,
      oldestLagSeconds: 2,
    });
  });

  it('records a generic failure without logging identity data', async () => {
    const claim = { sessionId: 'private-session', identityId: 'private-id', leaseToken: 'private-lease' };
    const repository = {
      enqueueBootstrap: vi.fn().mockResolvedValue(1),
      coalesceResolvedAliases: vi.fn().mockResolvedValue(0),
      catchUpMissingEvidence: vi.fn().mockResolvedValue(0),
      catchUpUnprojected: vi.fn().mockResolvedValue(0),
      backfillEvidence: vi.fn().mockResolvedValue(2_000),
      claim: vi.fn().mockResolvedValue(claim),
      projectBatch: vi.fn().mockRejectedValue(new Error('projection failed')),
      release: vi.fn(),
      fail: vi.fn().mockResolvedValue(undefined),
      getQueueMetrics: vi.fn(),
    } as unknown as ContactProjectionRepository;
    const warning = vi.spyOn(Logger.prototype, 'warn');
    await expect(new ContactProjectionTick(repository, options).run()).rejects.toThrow('projection failed');
    expect(repository.fail).toHaveBeenCalledWith(claim);
    expect(warning).toHaveBeenCalledWith({ event: 'contacts.projection.failed' });
  });
});
