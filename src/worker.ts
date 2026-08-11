import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { AppModule } from './app.module';
import { runtimeConfig } from './config/runtime-config';
import { DatabaseService } from './database/database.service';
import { GatewaySyncService } from './gateway/gateway-sync.service';
import type { FullGatewaySyncPayload, GroupCapabilityRefreshPayload } from './gateway/gateway-sync.types';
import { MessageJobRepository } from './messages/message-job.repository';
import type { MessageSendQueuePayload, MessageJobStatus } from './messages/message-job.types';
import { OpenWAClient, OpenWAHttpError } from './openwa/openwa.client';
import { GATEWAY_SYNC_QUEUE, MESSAGE_SEND_QUEUE, WEBHOOK_QUEUE } from './queue/queue.constants';
import { WebhookRepository } from './webhooks/webhook.repository';
import { normalizeOpenWAWebhook } from './webhooks/webhook-normalizer';
import { RuntimeEventRepository } from './webhooks/runtime-event.repository';

const webhookStatus = (event: string, data: Record<string, unknown>): MessageJobStatus | null => {
  if (event === 'message.sent') return 'SENT';
  if (event === 'message.failed') return 'FAILED';
  if (event !== 'message.ack') return null;
  const status = String(data.status ?? '').toLowerCase();
  return ({ sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' } as const)[status] ?? null;
};

const randomDelay = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

async function bootstrap(): Promise<void> {
  const config = runtimeConfig();
  const app = await NestFactory.createApplicationContext(AppModule);
  const database = app.get(DatabaseService);
  const messages = app.get(MessageJobRepository);
  const webhooks = app.get(WebhookRepository);
  const runtimeEvents = app.get(RuntimeEventRepository);
  const openwa = app.get(OpenWAClient);
  const gatewaySync = app.get(GatewaySyncService);
  const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

  const messageWorker = new Worker<MessageSendQueuePayload>(
    MESSAGE_SEND_QUEUE,
    async bullJob => {
      const job = await messages.markProcessing(bullJob.data.messageJobId);
      if (!job) return { skipped: true };

      if (job.dryRun) {
        await database.transaction(client =>
          messages.updateResult(client, job.id, 'DRY_RUN_COMPLETED', { response: { dryRun: true } }),
        );
        return { dryRun: true };
      }

      if (!config.ALLOW_LIVE_SENDS) {
        const error = 'Live send blocked: ALLOW_LIVE_SENDS=false';
        await database.transaction(client => messages.updateResult(client, job.id, 'FAILED', { error }));
        throw new Error(error);
      }

      await new Promise(resolve =>
        setTimeout(resolve, randomDelay(config.OUTBOUND_MIN_DELAY_MS, config.OUTBOUND_MAX_DELAY_MS)),
      );

      try {
        const result = await openwa.sendText(job.sessionId, job.recipientId, job.payload.text);
        await database.transaction(client =>
          messages.updateResult(client, job.id, 'ACCEPTED', {
            openwaMessageId: result.messageId,
            response: result,
          }),
        );
        return result;
      } catch (error) {
        const status: MessageJobStatus = error instanceof OpenWAHttpError ? 'FAILED' : 'UNKNOWN';
        const description = error instanceof Error ? error.message : String(error);
        await database.transaction(client => messages.updateResult(client, job.id, status, { error: description }));
        throw error;
      }
    },
    { connection, concurrency: 1 },
  );

  const webhookWorker = new Worker<{ idempotencyKey: string }>(
    WEBHOOK_QUEUE,
    async bullJob => {
      const envelope = await webhooks.find(bullJob.data.idempotencyKey);
      if (!envelope) return { missing: true };
      try {
        await runtimeEvents.store(normalizeOpenWAWebhook(envelope));
        const status = webhookStatus(envelope.event, envelope.data);
        const messageId = String(envelope.data.messageId ?? envelope.data.id ?? '');
        if (status && messageId) await messages.updateStatusByOpenWAMessageId(messageId, status);
        await webhooks.markProcessed(envelope.idempotencyKey);
        return { statusUpdated: Boolean(status && messageId) };
      } catch (error) {
        await webhooks.markProcessed(
          envelope.idempotencyKey,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    },
    { connection, concurrency: 10 },
  );

  const gatewaySyncWorker = new Worker<FullGatewaySyncPayload | GroupCapabilityRefreshPayload>(
    GATEWAY_SYNC_QUEUE,
    bullJob => {
      if (bullJob.name === 'refresh-group-capability') {
        const data = bullJob.data as GroupCapabilityRefreshPayload;
        return gatewaySync.refreshGroupCapability(data.sessionId, data.groupId, data.expectedRevision);
      }
      const data = bullJob.data as FullGatewaySyncPayload;
      return gatewaySync.perform(data.syncRunId, data.sessionId);
    },
    { connection, concurrency: 1 },
  );

  const shutdown = async () => {
    await Promise.all([messageWorker.close(), webhookWorker.close(), gatewaySyncWorker.close()]);
    connection.disconnect();
    await app.close();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

bootstrap().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
