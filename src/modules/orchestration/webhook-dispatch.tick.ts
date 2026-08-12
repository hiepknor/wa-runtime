import { Injectable, Logger } from '@nestjs/common';
import { stableQueueJobId } from '../../core/queue/queue-job-id';
import { QueueService } from '../../core/queue/queue.service';
import { WebhookRepository } from '../webhooks/webhook.repository';

@Injectable()
export class WebhookDispatchTick {
  private readonly logger = new Logger(WebhookDispatchTick.name);

  constructor(
    private readonly webhooks: WebhookRepository,
    private readonly queues: QueueService,
  ) {}

  async run(): Promise<void> {
    const recovered = await this.webhooks.recoverExpiredProcessing();
    if (recovered > 0) this.logger.warn({ event: 'webhooks.recovered', count: recovered });
    const events = await this.webhooks.listDispatchable(100);
    for (const event of events) {
      try {
        await this.queues.webhookIngress.add('process-openwa-webhook', event, {
          jobId: stableQueueJobId('webhook', event.idempotencyKey),
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        });
      } catch (error) {
        this.logger.error({
          event: 'queue.publish.failed', queue: 'webhook_ingress',
          webhookIdempotencyKey: event.idempotencyKey, error,
        });
        throw error;
      }
    }
  }
}
