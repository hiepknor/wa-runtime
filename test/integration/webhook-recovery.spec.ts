import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import type { SessionStateCacheService } from '../../src/modules/gateway/session-state-cache.service';
import type { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import { RuntimeEventRepository } from '../../src/modules/webhooks/runtime-event.repository';
import { WebhookProcessorService } from '../../src/modules/webhooks/webhook-processor.service';
import { WebhookRepository, type OpenWAWebhookEnvelope } from '../../src/modules/webhooks/webhook.repository';
import { INTEGRATION_GROUP_ID, INTEGRATION_SESSION_ID, integrationPool, resetIntegrationDatabase } from '../support/integration-database';

describe('durable webhook processing', () => {
  let pool: Pool;
  let database: DatabaseService;
  let webhooks: WebhookRepository;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    webhooks = new WebhookRepository(database);
  });

  beforeEach(() => resetIntegrationDatabase(pool));

  afterAll(async () => {
    await database.onApplicationShutdown();
    await pool.end();
  });

  it('normalizes a durable envelope and marks it processed', async () => {
    const envelope: OpenWAWebhookEnvelope = {
      event: 'message.received', timestamp: '2026-08-11T00:00:00.000Z',
      sessionId: INTEGRATION_SESSION_ID, idempotencyKey: 'webhook-event-1', deliveryId: 'delivery-1',
      data: {
        id: 'message-1', chatId: INTEGRATION_GROUP_ID, author: '84970000000@c.us', body: 'hello',
        type: 'text', fromMe: false, isGroup: true,
      },
    };
    const runtimeEvents = new RuntimeEventRepository(
      database,
      { invalidate: vi.fn() } as unknown as SessionStateCacheService,
    );
    const processor = new WebhookProcessorService(
      webhooks,
      runtimeEvents,
      { updateStatusByOpenWAMessageId: vi.fn() } as unknown as MessageJobRepository,
    );

    expect(await webhooks.insert(envelope)).toBe(true);
    await processor.process(envelope.idempotencyKey);

    const stored = await pool.query(
      `SELECT we.processing_state, re.event_type, im.body
       FROM webhook_events we
       JOIN runtime_events re ON re.event_id = we.idempotency_key
       JOIN inbound_messages im ON im.event_id = re.event_id
       WHERE we.idempotency_key = $1`,
      [envelope.idempotencyKey],
    );
    expect(stored.rows[0]).toMatchObject({
      processing_state: 'PROCESSED', event_type: 'message.received', body: 'hello',
    });
  });

  it('recovers an expired lease and eventually dead-letters a poison event', async () => {
    const envelope: OpenWAWebhookEnvelope = {
      event: 'unknown.event', timestamp: '2026-08-11T00:00:00.000Z',
      sessionId: INTEGRATION_SESSION_ID, idempotencyKey: 'poison-event', deliveryId: 'delivery-2', data: {},
    };
    await webhooks.insert(envelope);
    expect(await webhooks.claimForProcessing(envelope.idempotencyKey)).toEqual(envelope);
    await pool.query(
      `UPDATE webhook_events SET lease_expires_at = now() - interval '1 second'
       WHERE idempotency_key = $1`,
      [envelope.idempotencyKey],
    );

    expect(await webhooks.recoverExpiredProcessing()).toBe(1);
    expect(await webhooks.listDispatchable(10)).toContainEqual({ idempotencyKey: envelope.idempotencyKey });

    await webhooks.claimForProcessing(envelope.idempotencyKey);
    await pool.query('UPDATE webhook_events SET attempt_count = 5 WHERE idempotency_key = $1', [envelope.idempotencyKey]);
    expect(await webhooks.markFailed(envelope.idempotencyKey, 'invalid payload')).toBe('DEAD');
    const state = await pool.query(
      'SELECT processing_state, processing_error, dead_at FROM webhook_events WHERE idempotency_key = $1',
      [envelope.idempotencyKey],
    );
    expect(state.rows[0]).toMatchObject({ processing_state: 'DEAD', processing_error: 'invalid payload' });
    expect(state.rows[0].dead_at).toBeInstanceOf(Date);
  });
});
