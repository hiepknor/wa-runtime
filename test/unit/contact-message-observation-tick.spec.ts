import { describe, expect, it, vi } from 'vitest';
import type { ContactMessageObservationIntentRepository } from '../../src/modules/contacts/contact-message-observation-intent.repository';
import { ContactMessageObservationTick } from '../../src/modules/contacts/contact-message-observation.tick';
import type { ContactMessageObserverService } from '../../src/modules/contacts/contact-message-observer.service';

describe('ContactMessageObservationTick', () => {
  it('does not consume durable work while message enrichment is disabled', async () => {
    const intents = { recoverExpired: vi.fn(), claim: vi.fn() };
    const tick = new ContactMessageObservationTick(
      intents as unknown as ContactMessageObservationIntentRepository,
      {} as ContactMessageObserverService,
      { enabled: false, maxPerTick: 100 },
    );

    await tick.run();

    expect(intents.recoverExpired).not.toHaveBeenCalled();
    expect(intents.claim).not.toHaveBeenCalled();
  });

  it('completes successful observations and durably retries failures', async () => {
    const claims = [
      {
        eventId: 'event-1', sessionId: 'session-1', senderId: 'sender-1', pushName: 'First',
        observedAt: new Date('2026-08-21T00:00:00.000Z'), leaseToken: 'lease-1',
      },
      {
        eventId: 'event-2', sessionId: 'session-1', senderId: 'sender-2', pushName: 'Second',
        observedAt: new Date('2026-08-21T00:00:01.000Z'), leaseToken: 'lease-2',
      },
    ];
    const intents = {
      recoverExpired: vi.fn().mockResolvedValue(0),
      claim: vi.fn().mockResolvedValue(claims),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue('RETRY'),
    };
    const observer = {
      observe: vi.fn()
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('contacts unavailable')),
    };
    const tick = new ContactMessageObservationTick(
      intents as unknown as ContactMessageObservationIntentRepository,
      observer as unknown as ContactMessageObserverService,
      { enabled: true, maxPerTick: 100 },
    );

    await tick.run();

    expect(intents.claim).toHaveBeenCalledWith(100);
    expect(intents.complete).toHaveBeenCalledWith('event-1', 'lease-1');
    expect(intents.fail).toHaveBeenCalledWith('event-2', 'lease-2', 'contacts unavailable');
  });
});
