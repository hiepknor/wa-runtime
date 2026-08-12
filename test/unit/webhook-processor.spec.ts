import { describe, expect, it, vi } from 'vitest';
import type { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import type { RuntimeEventRepository } from '../../src/modules/webhooks/runtime-event.repository';
import { WebhookProcessorService } from '../../src/modules/webhooks/webhook-processor.service';
import type { OpenWAWebhookEnvelope, WebhookRepository } from '../../src/modules/webhooks/webhook.repository';

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
    );

    await expect(processor.process(envelope.idempotencyKey)).rejects.toThrow('database unavailable');
    expect(webhooks.markFailed).toHaveBeenCalledWith(
      envelope.idempotencyKey,
      claim.leaseToken,
      'database unavailable',
    );
    expect(webhooks.markProcessed).not.toHaveBeenCalled();
  });
});
