import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenWAClient } from '../../src/integrations/openwa/openwa.client';
import type { ContactRepository } from '../../src/modules/contacts/contact.repository';
import { ContactSyncService } from '../../src/modules/contacts/contact-sync.service';
import { ContactSnapshotConflictError } from '../../src/modules/contacts/contact-snapshot.errors';

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
      beginObservedSnapshot: vi.fn().mockResolvedValue({ generation: 3, leaseToken: 'lease-3' }),
      ingestObservedPage: vi.fn()
        .mockResolvedValueOnce({ observed: 1, enriched: 2 })
        .mockResolvedValueOnce({ observed: 1, enriched: 0 }),
      reconcileObservedIdentities: vi.fn().mockResolvedValue({ enriched: 1, merged: 1, conflicts: 1 }),
      completeObservedSnapshot: vi.fn().mockResolvedValue(undefined),
      getCoverageMetrics: vi.fn().mockResolvedValue({ member_records: 4, named_records: 3 }),
      failObservedSnapshot: vi.fn(),
    } as unknown as ContactRepository;

    await new ContactSyncService(repository, openwa).reconcileObservedContacts('session-1');

    expect(repository.ingestObservedPage).toHaveBeenCalledTimes(2);
    expect(repository.ingestObservedPage).toHaveBeenNthCalledWith(1, 'session-1', 3, 'lease-3', pages[0]);
    expect(repository.reconcileObservedIdentities).toHaveBeenCalledWith('session-1', 3, 'lease-3');
    expect(repository.completeObservedSnapshot).toHaveBeenCalledWith(
      'session-1', 3, 'lease-3', 2, 86_400_000,
    );
    expect(repository.failObservedSnapshot).not.toHaveBeenCalled();
  });

  it('records a bounded error category and preserves the previous observed snapshot', async () => {
    const openwa = {
      async *listContactPages() { throw new Error('raw upstream details'); },
    } as unknown as OpenWAClient;
    const repository = {
      beginObservedSnapshot: vi.fn().mockResolvedValue({ generation: 4, leaseToken: 'lease-4' }),
      failObservedSnapshot: vi.fn().mockResolvedValue(undefined),
    } as unknown as ContactRepository;

    await expect(new ContactSyncService(repository, openwa).reconcileObservedContacts('session-1'))
      .rejects.toThrow('raw upstream details');
    expect(repository.failObservedSnapshot).toHaveBeenCalledWith('session-1', 4, 'lease-4', 'UPSTREAM_ERROR');
  });

  it('does not call OpenWA when another snapshot owns the session lease', async () => {
    const openwa = { listContactPages: vi.fn() } as unknown as OpenWAClient;
    const repository = { beginObservedSnapshot: vi.fn().mockResolvedValue(null) } as unknown as ContactRepository;

    await expect(new ContactSyncService(repository, openwa).reconcileObservedContacts('session-1', false))
      .resolves.toBe(false);
    expect(openwa.listContactPages).not.toHaveBeenCalled();
  });

  it('classifies contradictory staged identities as an invalid response', async () => {
    const openwa = {
      async *listContactPages() { yield [{ id: 'conflict@lid' }]; },
    } as unknown as OpenWAClient;
    const repository = {
      beginObservedSnapshot: vi.fn().mockResolvedValue({ generation: 5, leaseToken: 'lease-5' }),
      ingestObservedPage: vi.fn().mockRejectedValue(new ContactSnapshotConflictError()),
      failObservedSnapshot: vi.fn().mockResolvedValue(undefined),
    } as unknown as ContactRepository;

    await expect(new ContactSyncService(repository, openwa).reconcileObservedContacts('session-1'))
      .rejects.toThrow(ContactSnapshotConflictError);
    expect(repository.failObservedSnapshot).toHaveBeenCalledWith(
      'session-1', 5, 'lease-5', 'INVALID_RESPONSE',
    );
  });
});
