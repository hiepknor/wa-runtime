import { describe, expect, it, vi } from 'vitest';
import type { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import type { RuntimeEventRepository } from '../../src/modules/webhooks/runtime-event.repository';
import { WebhookProcessorService } from '../../src/modules/webhooks/webhook-processor.service';
import type { OpenWAWebhookEnvelope, WebhookRepository } from '../../src/modules/webhooks/webhook.repository';
import type { ContactMessageObserverService } from '../../src/modules/contacts/contact-message-observer.service';

const envelope: OpenWAWebhookEnvelope = {
  event: 'message.ack', timestamp: '2026-08-11T00:00:00.000Z', sessionId: 'session-1',
  idempotencyKey: 'event-1', deliveryId: 'delivery-1',
  data: { messageId: 'message-1', status: 'delivered' },
};
const claim = { envelope, leaseToken: 'lease-1', attemptNumber: 1 };

describe('WebhookProcessorService', () => {
  it('persists, reconciles and marks a claimed event processed', async () => {
    const webhooks = {
      claimForProcessing: vi.fn().mockResolvedValue(claim),
      markProcessed: vi.fn().mockResolvedValue(true), markFailed: vi.fn(),
    };
    const runtimeEvents = { store: vi.fn().mockResolvedValue(undefined) };
    const messages = { updateStatusByOpenWAMessageId: vi.fn().mockResolvedValue(undefined) };
    const processor = new WebhookProcessorService(
      webhooks as unknown as WebhookRepository,
      runtimeEvents as unknown as RuntimeEventRepository,
      messages as unknown as MessageJobRepository,
      {} as ContactMessageObserverService,
    );

    await processor.process(envelope.idempotencyKey);

    expect(runtimeEvents.store).toHaveBeenCalledOnce();
    expect(messages.updateStatusByOpenWAMessageId).toHaveBeenCalledWith('message-1', 'DELIVERED');
    expect(webhooks.markProcessed).toHaveBeenCalledWith(envelope.idempotencyKey, claim.leaseToken);
    expect(webhooks.markFailed).not.toHaveBeenCalled();
  });

  it('records durable retry state when processing fails', async () => {
    const webhooks = {
      claimForProcessing: vi.fn().mockResolvedValue(claim), markProcessed: vi.fn(),
      markFailed: vi.fn().mockResolvedValue('RETRY'),
    };
    const runtimeEvents = { store: vi.fn().mockRejectedValue(new Error('database unavailable')) };
    const processor = new WebhookProcessorService(
      webhooks as unknown as WebhookRepository,
      runtimeEvents as unknown as RuntimeEventRepository,
      {} as MessageJobRepository,
      {} as ContactMessageObserverService,
    );

    await expect(processor.process(envelope.idempotencyKey)).rejects.toThrow('database unavailable');
    expect(webhooks.markFailed).toHaveBeenCalledWith(
      envelope.idempotencyKey,
      claim.leaseToken,
      'database unavailable',
    );
    expect(webhooks.markProcessed).not.toHaveBeenCalled();
  });

  it('observes only the normalized sender and push name from an inbound message', async () => {
    const messageEnvelope: OpenWAWebhookEnvelope = {
      ...envelope,
      event: 'message.received',
      data: {
        id: 'inbound-1', author: 'sender@lid', from: 'group@g.us',
        contact: { pushName: ' Sender name ', phone: 'must-not-be-forwarded' },
      },
    };
    const webhooks = {
      claimForProcessing: vi.fn().mockResolvedValue({ ...claim, envelope: messageEnvelope }),
      markProcessed: vi.fn().mockResolvedValue(true), markFailed: vi.fn(),
    };
    const contacts = { observe: vi.fn().mockResolvedValue(true) };
    const processor = new WebhookProcessorService(
      webhooks as unknown as WebhookRepository,
      { store: vi.fn() } as unknown as RuntimeEventRepository,
      {} as MessageJobRepository,
      contacts as unknown as ContactMessageObserverService,
    );

    await processor.process(messageEnvelope.idempotencyKey);

    expect(contacts.observe).toHaveBeenCalledWith(
      'session-1',
      'sender@lid',
      ' Sender name ',
      new Date('2026-08-11T00:00:00.000Z'),
      'event-1',
    );
  });

  it('does not poison a message webhook when optional contact enrichment fails', async () => {
    const messageEnvelope: OpenWAWebhookEnvelope = {
      ...envelope,
      event: 'message.received',
      data: { id: 'inbound-1', author: 'sender@lid', contact: { pushName: 'Sender' } },
    };
    const webhooks = {
      claimForProcessing: vi.fn().mockResolvedValue({ ...claim, envelope: messageEnvelope }),
      markProcessed: vi.fn().mockResolvedValue(true), markFailed: vi.fn(),
    };
    const processor = new WebhookProcessorService(
      webhooks as unknown as WebhookRepository,
      { store: vi.fn().mockResolvedValue(undefined) } as unknown as RuntimeEventRepository,
      {} as MessageJobRepository,
      { observe: vi.fn().mockRejectedValue(new Error('contacts unavailable')) } as unknown as ContactMessageObserverService,
    );

    await expect(processor.process(messageEnvelope.idempotencyKey)).resolves.toEqual({ statusUpdated: false });
    expect(webhooks.markProcessed).toHaveBeenCalledOnce();
    expect(webhooks.markFailed).not.toHaveBeenCalled();
  });
});
