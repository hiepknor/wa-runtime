import { Injectable, Logger } from '@nestjs/common';
import { MessageJobRepository } from '../messages/message-job.repository';
import type { MessageJobStatus } from '../messages/message-job.types';
import { normalizeOpenWAWebhook } from './webhook-normalizer';
import { RuntimeEventRepository } from './runtime-event.repository';
import { WebhookRepository } from './webhook.repository';
import { ContactMessageObserverService } from '../contacts/contact-message-observer.service';

const webhookStatus = (event: string, data: Record<string, unknown>): MessageJobStatus | null => {
  if (event === 'message.sent') return 'SENT';
  if (event === 'message.failed') return 'FAILED';
  if (event !== 'message.ack') return null;
  const status = String(data.status ?? '').toLowerCase();
  return ({ sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' } as const)[status] ?? null;
};

@Injectable()
export class WebhookProcessorService {
  private readonly logger = new Logger(WebhookProcessorService.name);

  constructor(
    private readonly webhooks: WebhookRepository,
    private readonly runtimeEvents: RuntimeEventRepository,
    private readonly messages: MessageJobRepository,
    private readonly contacts: ContactMessageObserverService,
  ) {}

  async process(idempotencyKey: string): Promise<unknown> {
    const claim = await this.webhooks.claimForProcessing(idempotencyKey);
    if (!claim) return { skipped: true };
    const { envelope, leaseToken } = claim;
    try {
      const runtimeEvent = normalizeOpenWAWebhook(envelope);
      await this.runtimeEvents.store(runtimeEvent);
      if (envelope.event === 'message.received') {
        const senderId = String(envelope.data.author ?? envelope.data.from ?? '');
        const contact = typeof envelope.data.contact === 'object' && envelope.data.contact !== null
          ? envelope.data.contact as Record<string, unknown>
          : null;
        const pushName = typeof contact?.pushName === 'string' ? contact.pushName : null;
        if (senderId && pushName) {
          await this.contacts.observe(
            envelope.sessionId,
            senderId,
            pushName,
            runtimeEvent.occurredAt,
            envelope.idempotencyKey,
          ).catch(() => {
            this.logger.warn({ event: 'contacts.message_sender.observe_failed' });
          });
        }
      }
      const status = webhookStatus(envelope.event, envelope.data);
      const messageId = String(envelope.data.messageId ?? envelope.data.id ?? '');
      if (status && messageId) await this.messages.updateStatusByOpenWAMessageId(messageId, status);
      if (!await this.webhooks.markProcessed(envelope.idempotencyKey, leaseToken)) {
        return { skipped: true, lostOwnership: true };
      }
      return { statusUpdated: Boolean(status && messageId) };
    } catch (error) {
      await this.webhooks.markFailed(
        envelope.idempotencyKey,
        leaseToken,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
}
