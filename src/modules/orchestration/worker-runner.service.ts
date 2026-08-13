import { Injectable, Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { runtimeConfig } from '../../core/config/runtime-config';
import { withCorrelationContext } from '../../core/observability/correlation-context';
import { CAMPAIGN_QUEUE, GATEWAY_SYNC_QUEUE, MESSAGE_SEND_QUEUE, WEBHOOK_QUEUE } from '../../core/queue/queue.constants';
import { RUNTIME_HEARTBEAT_INTERVAL_MS } from '../../core/queue/runtime-heartbeat';
import { QueueService } from '../../core/queue/queue.service';
import { CampaignRunProcessorService } from '../campaigns/campaign-run-processor.service';
import { GatewaySyncProcessorService } from '../gateway/gateway-sync-processor.service';
import type { FullGatewaySyncPayload, GroupCapabilityRefreshPayload, GroupReconciliationPayload, TargetedGroupReconciliationPayload } from '../gateway/gateway-sync.types';
import { MessageJobProcessorService } from '../messages/message-job-processor.service';
import type { MessageSendQueuePayload } from '../messages/message-job.types';
import { WebhookProcessorService } from '../webhooks/webhook-processor.service';

@Injectable()
export class WorkerRunnerService {
  private readonly logger = new Logger(WorkerRunnerService.name);

  constructor(
    private readonly messageProcessor: MessageJobProcessorService,
    private readonly webhookProcessor: WebhookProcessorService,
    private readonly gatewayProcessor: GatewaySyncProcessorService,
    private readonly campaignProcessor: CampaignRunProcessorService,
    private readonly queues: QueueService,
  ) {}

  async run(): Promise<void> {
    const connection = new IORedis(runtimeConfig().REDIS_URL, { maxRetriesPerRequest: null });
    const messageWorker = new Worker<MessageSendQueuePayload>(
      MESSAGE_SEND_QUEUE,
      job => this.runJob('message_send', job.name, String(job.id), {
        messageJobId: job.data.messageJobId,
      }, () => this.messageProcessor.process(job.data)),
      { connection, concurrency: 1 },
    );
    const webhookWorker = new Worker<{ idempotencyKey: string }>(
      WEBHOOK_QUEUE,
      job => this.runJob('webhook_ingress', job.name, String(job.id), {
        webhookIdempotencyKey: job.data.idempotencyKey,
      }, () => this.webhookProcessor.process(job.data.idempotencyKey)),
      { connection, concurrency: 10 },
    );
    const gatewayWorker = new Worker<FullGatewaySyncPayload | GroupCapabilityRefreshPayload | GroupReconciliationPayload | TargetedGroupReconciliationPayload>(
      GATEWAY_SYNC_QUEUE,
      job => this.runJob('gateway_sync', job.name, String(job.id), {
        sessionId: job.data.sessionId,
        ...('syncRunId' in job.data ? { syncRunId: job.data.syncRunId } : {}),
      }, () => this.gatewayProcessor.process(job.name, job.data)),
      { connection, concurrency: 1 },
    );
    const campaignWorker = new Worker<{ runId: string }>(
      CAMPAIGN_QUEUE,
      job => this.runJob('campaign', job.name, String(job.id), {
        campaignRunId: job.data.runId,
      }, () => this.campaignProcessor.process(job.data.runId)),
      { connection, concurrency: 2 },
    );
    const workers = [messageWorker, webhookWorker, gatewayWorker, campaignWorker];
    const heartbeat = setInterval(() => void this.publishHeartbeat(), RUNTIME_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    await this.publishHeartbeat();
    for (const worker of workers) {
      worker.on('error', error => this.logger.error({ event: 'worker.connection.error', queue: worker.name, error }));
    }
    await new Promise<void>(resolve => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
    await Promise.all(workers.map(worker => worker.close()));
    clearInterval(heartbeat);
    connection.disconnect();
  }

  private async publishHeartbeat(): Promise<void> {
    try {
      await this.queues.publishHeartbeat('worker');
    } catch (error) {
      this.logger.error({ event: 'runtime.heartbeat.failed', process: 'worker', error });
    }
  }

  private runJob<T>(
    queue: string,
    jobName: string,
    bullJobId: string,
    context: Record<string, string>,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withCorrelationContext({ bullJobId, ...context }, async () => {
      try {
        return await operation();
      } catch (error) {
        this.logger.error({ event: 'worker.job.failed', queue, jobName, error });
        throw error;
      }
    });
  }
}
