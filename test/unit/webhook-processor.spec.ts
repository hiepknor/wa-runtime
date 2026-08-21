import { describe, expect, it, vi } from 'vitest';
import type { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import type { RuntimeEventRepository } from '../../src/modules/webhooks/runtime-event.repository';
import { WebhookProcessorService } from '../../src/modules/webhooks/webhook-processor.service';
import type { OpenWAWebhookEnvelope, WebhookRepository } from '../../src/modules/webhooks/webhook.repository';
import type { ContactMessageObserverService } from '../../src/modules/contacts/contact-message-observer.service';
import type { DatabaseService } from '../../src/core/database/database.service';

const envelope: OpenWAWebhookEnvelope = {
  event: 'message.ack', timestamp: '2026-08-11T00:00:00.000Z', sessionId: 'session-1',
  idempotencyKey: 'event-1', deliveryId: 'delivery-1',
  data: { messageId: 'message-1', status: 'delivered' },
};
const claim = { envelope, leaseToken: 'lease-1', attemptNumber: 1 };
const client = {} as never;

const databaseMock = () => ({
  transaction: vi.fn(async (operation: (transactionClient: never) => Promise<unknown>) => operation(client)),
});

describe('WebhookProcessorService', () => {
  it('persists, reconciles and marks a claimed event processed', async () => {
    const database = databaseMock();
    const webhooks = {
      claimForProcessing: vi.fn().mockResolvedValue(claim),
      lockProcessingLease: vi.fn().mockResolvedValue(true),
      markProcessedInTransaction: vi.fn().mockResolvedValue(true), markFailed: vi.fn(),
    };
    const runtimeEvents = { storeInTransaction: vi.fn().mockResolvedValue(true) };
    const messages = { updateStatusByOpenWAMessageIdWithClient: vi.fn().mockResolvedValue(undefined) };
    const processor = new WebhookProcessorService(
      database as unknown as DatabaseService,
      webhooks as unknown as WebhookRepository,
      runtimeEvents as unknown as RuntimeEventRepository,
      messages as unknown as MessageJobRepository,
      {} as ContactMessageObserverService,
    );

    await processor.process(envelope.idempotencyKey);

    expect(runtimeEvents.storeInTransaction).toHaveBeenCalledOnce();
    expect(messages.updateStatusByOpenWAMessageIdWithClient).toHaveBeenCalledWith(
      client, 'message-1', 'DELIVERED',
    );
    expect(webhooks.markProcessedInTransaction).toHaveBeenCalledWith(
      client, envelope.idempotencyKey, claim.leaseToken,
    );
    expect(webhooks.markFailed).not.toHaveBeenCalled();
  });

  it('records durable retry state when processing fails', async () => {
    const database = databaseMock();
    const webhooks = {
      claimForProcessing: vi.fn().mockResolvedValue(claim),
      lockProcessingLease: vi.fn().mockResolvedValue(true), markProcessedInTransaction: vi.fn(),
      markFailed: vi.fn().mockResolvedValue('RETRY'),
    };
    const runtimeEvents = { storeInTransaction: vi.fn().mockRejectedValue(new Error('database unavailable')) };
    const processor = new WebhookProcessorService(
      database as unknown as DatabaseService,
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
    expect(webhooks.markProcessedInTransaction).not.toHaveBeenCalled();
  });

  it('observes only the normalized sender and push name from an inbound message', async () => {
    const database = databaseMock();
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
      lockProcessingLease: vi.fn().mockResolvedValue(true),
      markProcessedInTransaction: vi.fn().mockResolvedValue(true), markFailed: vi.fn(),
    };
    const contacts = { enqueue: vi.fn().mockResolvedValue(true) };
    const processor = new WebhookProcessorService(
      database as unknown as DatabaseService,
      webhooks as unknown as WebhookRepository,
      { storeInTransaction: vi.fn() } as unknown as RuntimeEventRepository,
      {} as MessageJobRepository,
      contacts as unknown as ContactMessageObserverService,
    );

    await processor.process(messageEnvelope.idempotencyKey);

    expect(contacts.enqueue).toHaveBeenCalledWith(client, {
      eventId: 'event-1',
      sessionId: 'session-1',
      senderId: 'sender@lid',
      pushName: ' Sender name ',
      observedAt: new Date('2026-08-11T00:00:00.000Z'),
    });
  });

  it('retries the webhook when its durable contact intent cannot be recorded', async () => {
    const database = databaseMock();
    const messageEnvelope: OpenWAWebhookEnvelope = {
      ...envelope,
      event: 'message.received',
      data: { id: 'inbound-1', author: 'sender@lid', contact: { pushName: 'Sender' } },
    };
    const webhooks = {
      claimForProcessing: vi.fn().mockResolvedValue({ ...claim, envelope: messageEnvelope }),
      lockProcessingLease: vi.fn().mockResolvedValue(true), markProcessedInTransaction: vi.fn(),
      markFailed: vi.fn().mockResolvedValue('RETRY'),
    };
    const processor = new WebhookProcessorService(
      database as unknown as DatabaseService,
      webhooks as unknown as WebhookRepository,
      { storeInTransaction: vi.fn().mockResolvedValue(true) } as unknown as RuntimeEventRepository,
      {} as MessageJobRepository,
      { enqueue: vi.fn().mockRejectedValue(new Error('contacts unavailable')) } as unknown as ContactMessageObserverService,
    );

    await expect(processor.process(messageEnvelope.idempotencyKey)).rejects.toThrow('contacts unavailable');
    expect(webhooks.markProcessedInTransaction).not.toHaveBeenCalled();
    expect(webhooks.markFailed).toHaveBeenCalledOnce();
  });
});
