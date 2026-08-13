import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import type { SessionStateCacheService } from '../../src/modules/gateway/session-state-cache.service';
import type { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import { RuntimeEventRepository } from '../../src/modules/webhooks/runtime-event.repository';
import { GatewayGroupIntentRepository } from '../../src/modules/gateway/gateway-group-intent.repository';
import { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import { GatewaySyncItemRepository } from '../../src/modules/gateway/gateway-sync-item.repository';
import { GatewaySyncService } from '../../src/modules/gateway/gateway-sync.service';
import type { OpenWAClient } from '../../src/integrations/openwa/openwa.client';
import { WebhookProcessorService } from '../../src/modules/webhooks/webhook-processor.service';
import { WebhookRepository, type OpenWAWebhookEnvelope } from '../../src/modules/webhooks/webhook.repository';
import { INTEGRATION_GROUP_ID, INTEGRATION_SESSION_ID, integrationPool, resetIntegrationDatabase, seedSendableGroup } from '../support/integration-database';

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
      new GatewayGroupIntentRepository(database),
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
    const firstClaim = await webhooks.claimForProcessing(envelope.idempotencyKey);
    expect(firstClaim?.envelope).toEqual(envelope);
    await pool.query(
      `UPDATE webhook_events SET lease_expires_at = now() - interval '1 second'
       WHERE idempotency_key = $1`,
      [envelope.idempotencyKey],
    );

    expect(await webhooks.recoverExpiredProcessing()).toBe(1);
    expect(await webhooks.listDispatchable(10)).toContainEqual({ idempotencyKey: envelope.idempotencyKey });

    const secondClaim = await webhooks.claimForProcessing(envelope.idempotencyKey);
    expect(secondClaim).not.toBeNull();
    await pool.query('UPDATE webhook_events SET attempt_count = 5 WHERE idempotency_key = $1', [envelope.idempotencyKey]);
    expect(await webhooks.markFailed(
      envelope.idempotencyKey,
      secondClaim!.leaseToken,
      'invalid payload',
    )).toBe('DEAD');
    const state = await pool.query(
      'SELECT processing_state, processing_error, dead_at FROM webhook_events WHERE idempotency_key = $1',
      [envelope.idempotencyKey],
    );
    expect(state.rows[0]).toMatchObject({ processing_state: 'DEAD', processing_error: 'invalid payload' });
    expect(state.rows[0].dead_at).toBeInstanceOf(Date);
  });

  it('fences a stale attempt after the event is reclaimed', async () => {
    const envelope: OpenWAWebhookEnvelope = {
      event: 'session.status', timestamp: '2026-08-11T00:00:00.000Z',
      sessionId: INTEGRATION_SESSION_ID, idempotencyKey: 'fenced-webhook',
      deliveryId: 'delivery-fenced', data: { status: 'ready' },
    };
    await webhooks.insert(envelope);
    const stale = await webhooks.claimForProcessing(envelope.idempotencyKey);
    expect(stale).not.toBeNull();
    await pool.query(
      `UPDATE webhook_events SET lease_expires_at = now() - interval '1 second'
       WHERE idempotency_key = $1`,
      [envelope.idempotencyKey],
    );
    await webhooks.recoverExpiredProcessing();
    const current = await webhooks.claimForProcessing(envelope.idempotencyKey);
    expect(current).not.toBeNull();
    expect(current!.leaseToken).not.toBe(stale!.leaseToken);

    expect(await webhooks.markProcessed(envelope.idempotencyKey, stale!.leaseToken)).toBe(false);
    expect(await webhooks.markFailed(
      envelope.idempotencyKey,
      stale!.leaseToken,
      'stale failure',
    )).toBe('LOST_OWNERSHIP');
    expect(await webhooks.markProcessed(envelope.idempotencyKey, current!.leaseToken)).toBe(true);
  });

  it('coalesces duplicate and burst group events into one targeted intent', async () => {
    await seedSendableGroup(pool);
    const intents = new GatewayGroupIntentRepository(database);
    const runtimeEvents = new RuntimeEventRepository(
      database,
      { invalidate: vi.fn() } as unknown as SessionStateCacheService,
      intents,
    );
    const processor = new WebhookProcessorService(
      webhooks,
      runtimeEvents,
      { updateStatusByOpenWAMessageId: vi.fn() } as unknown as MessageJobRepository,
    );
    const event = (index: number): OpenWAWebhookEnvelope => ({
      event: 'group.update', timestamp: '2026-08-11T00:00:00.000Z',
      sessionId: INTEGRATION_SESSION_ID, idempotencyKey: `group-event-${index}`,
      deliveryId: `group-delivery-${index}`, data: { groupId: INTEGRATION_GROUP_ID },
    });

    await webhooks.insert(event(1));
    await processor.process(event(1).idempotencyKey);
    expect(await webhooks.insert(event(1))).toBe(false);
    for (let index = 2; index <= 20; index += 1) {
      await webhooks.insert(event(index));
      await processor.process(event(index).idempotencyKey);
    }

    const stored = await pool.query<{
      requested_revision: string; coalesced_count: string; status: string; reasons: string[];
    }>(
      `SELECT requested_revision::text, coalesced_count::text, status, reasons
       FROM gateway_group_reconciliation_intents WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(stored.rows[0]).toMatchObject({
      requested_revision: '20', coalesced_count: '19', status: 'PENDING', reasons: ['group.update'],
    });
    const dispatchable = await intents.listDispatchable(10);
    expect(dispatchable).toHaveLength(1);
    expect(dispatchable[0]!.availableAt).toBeInstanceOf(Date);

    await pool.query(
      `UPDATE gateway_group_reconciliation_intents SET not_before = now(), next_attempt_at = now()
       WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    const openwa = {
      getGroup: vi.fn().mockResolvedValue({
        id: INTEGRATION_GROUP_ID, name: 'Coalesced group', participants: [],
        isAdmin: true, isReadOnly: false, announce: false,
      }),
    } as unknown as OpenWAClient;
    const sync = new GatewaySyncService(
      new GatewayRepository(database), new GatewaySyncItemRepository(database), openwa, intents,
    );
    await expect(sync.reconcileTargetedGroup(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID))
      .resolves.toMatchObject({ members: 0 });
    expect(openwa.getGroup).toHaveBeenCalledTimes(1);
  });

  it('runs a subsequent revision when an event arrives during targeted reconciliation', async () => {
    await seedSendableGroup(pool);
    const intents = new GatewayGroupIntentRepository(database);
    const runtimeEvents = new RuntimeEventRepository(
      database,
      { invalidate: vi.fn() } as unknown as SessionStateCacheService,
      intents,
    );
    await runtimeEvents.store({
      eventId: 'running-event-1', sourceEventType: 'group.update', eventType: 'group.update', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt: new Date(), payload: { groupId: INTEGRATION_GROUP_ID },
    });
    await pool.query(
      `UPDATE gateway_group_reconciliation_intents SET not_before = now(), next_attempt_at = now()
       WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    let release!: () => void;
    const upstreamStarted = new Promise<void>(resolve => { release = resolve; });
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const openwa = {
      getGroup: vi.fn(async () => {
        release();
        await blocked;
        return {
          id: INTEGRATION_GROUP_ID, name: 'Updated group', participants: [],
          isAdmin: true, isReadOnly: false, announce: false,
        };
      }),
    } as unknown as OpenWAClient;
    const sync = new GatewaySyncService(
      new GatewayRepository(database), new GatewaySyncItemRepository(database), openwa, intents,
    );
    const first = sync.reconcileTargetedGroup(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID);
    await upstreamStarted;
    await runtimeEvents.store({
      eventId: 'running-event-2', sourceEventType: 'group.join', eventType: 'group.join', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt: new Date(), payload: { groupId: INTEGRATION_GROUP_ID },
    });
    unblock();
    await expect(first).resolves.toMatchObject({ pending: true });

    const state = await pool.query<{ requested_revision: string; completed_revision: string; status: string }>(
      `SELECT requested_revision::text, completed_revision::text, status
       FROM gateway_group_reconciliation_intents WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(state.rows[0]).toMatchObject({
      requested_revision: '2', completed_revision: '1', status: 'PENDING',
    });
  });

  it('recovers an expired attempt as pending when a newer revision arrived', async () => {
    await seedSendableGroup(pool);
    const intents = new GatewayGroupIntentRepository(database);
    const runtimeEvents = new RuntimeEventRepository(
      database,
      { invalidate: vi.fn() } as unknown as SessionStateCacheService,
      intents,
    );
    await runtimeEvents.store({
      eventId: 'expired-event-1', sourceEventType: 'group.update', eventType: 'group.update', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt: new Date(), payload: { groupId: INTEGRATION_GROUP_ID },
    });
    await pool.query(
      `UPDATE gateway_group_reconciliation_intents SET not_before = now(), next_attempt_at = now()
       WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    const claim = await intents.claim(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID);
    expect(claim).not.toBeNull();
    await runtimeEvents.store({
      eventId: 'expired-event-2', sourceEventType: 'group.join', eventType: 'group.join', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt: new Date(), payload: { groupId: INTEGRATION_GROUP_ID },
    });
    await pool.query(
      `UPDATE gateway_group_reconciliation_intents SET attempt_count = 5,
         lease_expires_at = now() - interval '1 second'
       WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );

    expect(await intents.recoverExpired()).toBe(1);
    const state = await pool.query(
      `SELECT status, attempt_count, requested_revision::text, completed_revision::text
       FROM gateway_group_reconciliation_intents WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(state.rows[0]).toMatchObject({
      status: 'PENDING', attempt_count: 0, requested_revision: '2', completed_revision: '0',
    });
  });
});
