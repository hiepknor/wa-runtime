import { describe, expect, it, vi } from 'vitest';
import type { ContactRepository } from '../../src/modules/contacts/contact.repository';
import type { ContactSyncService } from '../../src/modules/contacts/contact-sync.service';
import { ContactPeriodicSyncTick } from '../../src/modules/contacts/contact-periodic-sync.tick';

describe('ContactPeriodicSyncTick', () => {
  it('does nothing while disabled', async () => {
    const repository = { listPeriodicSessionIds: vi.fn() };
    await new ContactPeriodicSyncTick(
      repository as unknown as ContactRepository,
      {} as ContactSyncService,
      { enabled: false, allowedSessionIds: ['allowed'] },
    ).run();
    expect(repository.listPeriodicSessionIds).not.toHaveBeenCalled();
  });

  it('processes only due allowlisted sessions and isolates per-session failure', async () => {
    const repository = { listPeriodicSessionIds: vi.fn().mockResolvedValue(['first', 'second']) };
    const sync = {
      reconcileObservedContacts: vi.fn()
        .mockRejectedValueOnce(new Error('upstream unavailable'))
        .mockResolvedValueOnce(true),
    };
    await new ContactPeriodicSyncTick(
      repository as unknown as ContactRepository,
      sync as unknown as ContactSyncService,
      { enabled: true, allowedSessionIds: ['first', 'second'] },
    ).run();

    expect(repository.listPeriodicSessionIds).toHaveBeenCalledWith(['first', 'second'], 10);
    expect(sync.reconcileObservedContacts).toHaveBeenNthCalledWith(1, 'first', false);
    expect(sync.reconcileObservedContacts).toHaveBeenNthCalledWith(2, 'second', false);
  });
});
