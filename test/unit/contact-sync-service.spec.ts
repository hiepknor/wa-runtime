import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenWAClient } from '../../src/integrations/openwa/openwa.client';
import type { ContactRepository } from '../../src/modules/contacts/contact.repository';
import { ContactSyncService } from '../../src/modules/contacts/contact-sync.service';

describe('ContactSyncService', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('persists one bounded page at a time and completes the observed generation', async () => {
    const pages = [[{ id: 'first@lid' }], [{ id: 'second@c.us' }]];
    const openwa = {
      async *listContactPages() { for (const page of pages) yield page; },
    } as unknown as OpenWAClient;
    const repository = {
      beginObservedSnapshot: vi.fn().mockResolvedValue(3),
      ingestObservedPage: vi.fn()
        .mockResolvedValueOnce({ observed: 1, enriched: 2, conflicts: 0 })
        .mockResolvedValueOnce({ observed: 1, enriched: 0, conflicts: 1 }),
      completeObservedSnapshot: vi.fn().mockResolvedValue(undefined),
      failObservedSnapshot: vi.fn(),
    } as unknown as ContactRepository;

    await new ContactSyncService(repository, openwa).reconcileObservedContacts('session-1');

    expect(repository.ingestObservedPage).toHaveBeenCalledTimes(2);
    expect(repository.completeObservedSnapshot).toHaveBeenCalledWith('session-1', 3, 2);
    expect(repository.failObservedSnapshot).not.toHaveBeenCalled();
  });

  it('records a bounded error category and preserves the previous observed snapshot', async () => {
    const openwa = {
      async *listContactPages() { throw new Error('raw upstream details'); },
    } as unknown as OpenWAClient;
    const repository = {
      beginObservedSnapshot: vi.fn().mockResolvedValue(4),
      failObservedSnapshot: vi.fn().mockResolvedValue(undefined),
    } as unknown as ContactRepository;

    await expect(new ContactSyncService(repository, openwa).reconcileObservedContacts('session-1'))
      .rejects.toThrow('raw upstream details');
    expect(repository.failObservedSnapshot).toHaveBeenCalledWith('session-1', 4, 'UPSTREAM_ERROR');
  });
});
