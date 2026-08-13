import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { QueueService } from '../../src/core/queue/queue.service';
import { stableQueueJobId } from '../../src/core/queue/queue-job-id';
import {
  runtimeHeartbeatKey,
  schedulerTickStateKey,
  type SchedulerTickState,
} from '../../src/core/queue/runtime-heartbeat';
import { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import { MessageDispatchTick } from '../../src/modules/orchestration/message-dispatch.tick';
import { WebhookDispatchTick } from '../../src/modules/orchestration/webhook-dispatch.tick';
import { WebhookRepository, type OpenWAWebhookEnvelope } from '../../src/modules/webhooks/webhook.repository';
import { messageRequestHash } from '../../src/modules/messages/message-idempotency';
import { INTEGRATION_GROUP_ID, INTEGRATION_SESSION_ID, integrationPool, resetIntegrationDatabase } from '../support/integration-database';

describe('Redis loss recovery', () => {
  let pool: Pool;
  let database: DatabaseService;
  let messages: MessageJobRepository;
  let queues: QueueService;
  let redis: IORedis;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    messages = new MessageJobRepository(database);
    queues = new QueueService();
    redis = new IORedis(process.env.REDIS_URL!);
  });
  beforeEach(async () => { await resetIntegrationDatabase(pool); await redis.flushall(); });
  afterAll(async () => {
    redis.disconnect();
    await queues.onApplicationShutdown();
    await database.onApplicationShutdown();
    await pool.end();
  });

  it('reconstructs a lost BullMQ job from the durable message row', async () => {
    const created = await messages.create({
      idempotencyScope: 'runtime-api', idempotencyKey: 'redis-loss',
      requestHash: messageRequestHash({
        sessionId: INTEGRATION_SESSION_ID, recipientId: INTEGRATION_GROUP_ID,
        text: 'hello', scheduledAt: null, dryRun: true,
      }),
      sessionId: INTEGRATION_SESSION_ID, recipientId: INTEGRATION_GROUP_ID,
      // Keep the row unambiguously due even when the host and Docker VM clocks differ by a few milliseconds.
      text: 'hello', scheduledAt: new Date(Date.now() - 1_000), dryRun: true,
    });
    const tick = new MessageDispatchTick(messages, queues);
    await tick.run();
    expect(await queues.messageSend.getJob(created.job.id)).not.toBeUndefined();

    await redis.flushall();
    expect(await queues.messageSend.getJob(created.job.id)).toBeUndefined();
    await pool.query(
      `UPDATE message_jobs SET updated_at = now() - interval '3 minutes' WHERE id = $1`, [created.job.id],
    );

    await tick.run();

    expect(await queues.messageSend.getJob(created.job.id)).not.toBeUndefined();
    expect(await messages.find(created.job.id)).toMatchObject({ status: 'QUEUED' });
  });

  it('publishes a webhook that was committed while no queue job existed', async () => {
    const webhooks = new WebhookRepository(database);
    const envelope: OpenWAWebhookEnvelope = {
      event: 'session.status', timestamp: '2026-08-11T00:00:00.000Z',
      sessionId: INTEGRATION_SESSION_ID, idempotencyKey: 'committed-before-enqueue',
      deliveryId: 'delivery-1', data: { status: 'ready' },
    };
    await webhooks.insert(envelope);
    expect(await queues.webhookIngress.getJob(stableQueueJobId('webhook', envelope.idempotencyKey))).toBeUndefined();

    await new WebhookDispatchTick(webhooks, queues).run();

    expect(await queues.webhookIngress.getJob(stableQueueJobId('webhook', envelope.idempotencyKey))).not.toBeUndefined();
  });

  it('publishes process and scheduler telemetry in the WA Runtime namespace', async () => {
    const state: SchedulerTickState = {
      name: 'messages', running: false, timedOut: false, consecutiveFailures: 0,
      lastStartedAt: null, lastSuccessAt: new Date().toISOString(), lastFailureAt: null,
      lastDurationMs: 1, nextRunAt: null,
    };

    await queues.publishHeartbeat('worker');
    await queues.publishSchedulerTickState(state);

    const values = await redis.mget(runtimeHeartbeatKey('worker'), schedulerTickStateKey('messages'));
    expect(values.every(Boolean)).toBe(true);
  });
});
