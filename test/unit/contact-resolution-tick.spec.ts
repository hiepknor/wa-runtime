import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactResolutionRepository } from '../../src/modules/contacts/contact-resolution.repository';
import { ContactResolutionTick } from '../../src/modules/contacts/contact-resolution.tick';

describe('ContactResolutionTick', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('does not scan published generations while disabled', async () => {
    const repository = { enqueuePublished: vi.fn() } as unknown as ContactResolutionRepository;
    await new ContactResolutionTick(repository, { enabled: false, maxRunsPerTick: 2 }).run();
    expect(repository.enqueuePublished).not.toHaveBeenCalled();
  });

  it('processes only the configured number of durable claims', async () => {
    const claims = [
      { sessionId: 'session-1', runId: 'run-1', leaseToken: 'lease-1' },
      { sessionId: 'session-1', runId: 'run-2', leaseToken: 'lease-2' },
    ];
    const repository = {
      enqueuePublished: vi.fn().mockResolvedValue(2),
      claim: vi.fn().mockResolvedValueOnce(claims[0]).mockResolvedValueOnce(claims[1]),
      resolve: vi.fn().mockResolvedValue({
        identities: 3, clusters: 1, linkedIdentities: 3, conflictIdentities: 0,
      }),
      fail: vi.fn(),
    } as unknown as ContactResolutionRepository;

    await new ContactResolutionTick(repository, { enabled: true, maxRunsPerTick: 2 }).run();

    expect(repository.enqueuePublished).toHaveBeenCalledWith(4);
    expect(repository.resolve).toHaveBeenCalledTimes(2);
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it('records bounded retry state without logging claim identifiers', async () => {
    const claim = { sessionId: 'private-session', runId: 'private-run', leaseToken: 'private-lease' };
    const repository = {
      enqueuePublished: vi.fn().mockResolvedValue(1),
      claim: vi.fn().mockResolvedValue(claim),
      resolve: vi.fn().mockRejectedValue(new Error('resolution failed')),
      fail: vi.fn().mockResolvedValue(undefined),
    } as unknown as ContactResolutionRepository;
    const warning = vi.spyOn(Logger.prototype, 'warn');

    await expect(new ContactResolutionTick(
      repository,
      { enabled: true, maxRunsPerTick: 1 },
    ).run()).rejects.toThrow('resolution failed');

    expect(repository.fail).toHaveBeenCalledWith(claim);
    expect(warning).toHaveBeenCalledWith({ event: 'contacts.resolution.failed' });
  });
});
