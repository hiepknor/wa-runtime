import { Injectable, Logger } from '@nestjs/common';
import { QueueService } from '../../core/queue/queue.service';
import { MessageJobRepository } from '../messages/message-job.repository';

@Injectable()
export class MessageDispatchTick {
  private readonly logger = new Logger(MessageDispatchTick.name);

  constructor(
    private readonly messages: MessageJobRepository,
    private readonly queues: QueueService,
  ) {}

  async run(): Promise<void> {
    const staleQueued = await this.messages.recoverStaleQueued();
    const expiredProcessing = await this.messages.markExpiredProcessingUnknown();
    if (staleQueued > 0 || expiredProcessing > 0) {
      this.logger.warn({
        event: 'message_jobs.recovered',
        staleQueued,
        expiredProcessingUnknown: expiredProcessing,
      });
    }
    const jobs = await this.messages.claimDue(100);
    for (const job of jobs) {
      try {
        await this.queues.messageSend.add('send-text', { messageJobId: job.id }, {
          jobId: job.id, attempts: 1, removeOnComplete: 1000, removeOnFail: 5000,
        });
      } catch (error) {
        this.logger.error({ event: 'queue.publish.failed', queue: 'message_send', messageJobId: job.id, error });
        await this.messages.resetQueued(job.id, error instanceof Error ? error.message : String(error));
      }
    }
  }
}
