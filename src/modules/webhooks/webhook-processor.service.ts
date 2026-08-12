import { Injectable } from '@nestjs/common';
import { MessageJobRepository } from '../messages/message-job.repository';
import type { MessageJobStatus } from '../messages/message-job.types';
import { normalizeOpenWAWebhook } from './webhook-normalizer';
import { RuntimeEventRepository } from './runtime-event.repository';
import { WebhookRepository } from './webhook.repository';

const webhookStatus = (event: string, data: Record<string, unknown>): MessageJobStatus | null => {
  if (event === 'message.sent') return 'SENT';
  if (event === 'message.failed') return 'FAILED';
  if (event !== 'message.ack') return null;
  const status = String(data.status ?? '').toLowerCase();
  return ({ sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' } as const)[status] ?? null;
};

@Injectable()
export class WebhookProcessorService {
  constructor(
    private readonly webhooks: WebhookRepository,
    private readonly runtimeEvents: RuntimeEventRepository,
    private readonly messages: MessageJobRepository,
  ) {}

  async process(idempotencyKey: string): Promise<unknown> {
    const envelope = await this.webhooks.claimForProcessing(idempotencyKey);
    if (!envelope) return { skipped: true };
    try {
      await this.runtimeEvents.store(normalizeOpenWAWebhook(envelope));
      const status = webhookStatus(envelope.event, envelope.data);
      const messageId = String(envelope.data.messageId ?? envelope.data.id ?? '');
      if (status && messageId) await this.messages.updateStatusByOpenWAMessageId(messageId, status);
      await this.webhooks.markProcessed(envelope.idempotencyKey);
      return { statusUpdated: Boolean(status && messageId) };
    } catch (error) {
      await this.webhooks.markFailed(
        envelope.idempotencyKey,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
}
