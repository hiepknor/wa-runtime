import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { runtimeConfig } from '../../src/core/config/runtime-config';
import type { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import { RuntimeEventRepository } from '../../src/modules/webhooks/runtime-event.repository';
import { GatewayGroupIntentRepository } from '../../src/modules/gateway/gateway-group-intent.repository';
import { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import { ContactRepository } from '../../src/modules/contacts/contact.repository';
import { ContactMessageObserverService } from '../../src/modules/contacts/contact-message-observer.service';
import { ContactMessageObservationIntentRepository } from '../../src/modules/contacts/contact-message-observation-intent.repository';
import { ContactMessageObservationTick } from '../../src/modules/contacts/contact-message-observation.tick';
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
    webhooks = new WebhookRepository(database, {
      ...runtimeConfig(),
      RUNTIME_COMPACT_PROCESSED_WEBHOOK_PAYLOAD_ENABLED: true,
    });
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
      new GatewayGroupIntentRepository(database),
      { ...runtimeConfig(), RUNTIME_COMPACT_EVENT_PAYLOAD_ENABLED: true },
    );
    const processor = new WebhookProcessorService(
      database,
      webhooks,
      runtimeEvents,
      { updateStatusByOpenWAMessageId: vi.fn() } as unknown as MessageJobRepository,
      new ContactMessageObserverService(
        new ContactRepository(database),
        new ContactMessageObservationIntentRepository(database),
        true,
      ),
    );

    expect(await webhooks.insert(envelope)).toBe(true);
    await processor.process(envelope.idempotencyKey);

    const stored = await pool.query<{
      processing_state: string;
      raw_payload: Record<string, unknown>;
      event_type: string;
      event_version: number;
      event_payload: Record<string, unknown>;
      body: string;
    }>(
      `SELECT we.processing_state, we.payload AS raw_payload, re.event_type, re.event_version,
         re.payload AS event_payload, im.body
       FROM webhook_events we
       JOIN runtime_events re ON re.event_id = we.idempotency_key
       JOIN inbound_messages im ON im.event_id = re.event_id
       WHERE we.idempotency_key = $1`,
      [envelope.idempotencyKey],
    );
    expect(stored.rows[0]).toMatchObject({
      processing_state: 'PROCESSED',
      raw_payload: { event: 'message.received', data: {} },
      event_type: 'message.received',
      event_version: 2,
      body: 'hello',
    });
    expect(stored.rows[0]!.event_payload).not.toHaveProperty('body');
    expect(stored.rows[0]!.event_payload).toMatchObject({ bodyBytes: 5 });
  });

  it('enriches a synchronized member from message push-name evidence without storing raw contact data', async () => {
    await seedSendableGroup(pool);
    const memberId = '84970000000@c.us';
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, is_admin, is_super_admin)
       VALUES ($1, $2, $3, '84970000000', false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, memberId],
    );
    const contacts = new ContactRepository(database);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await contacts.seedGroupMembers(client, INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, [{
        id: memberId, number: '84970000000', name: null, isAdmin: false, isSuperAdmin: false,
      }]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const envelope: OpenWAWebhookEnvelope = {
      event: 'message.received', timestamp: '2026-08-11T00:00:00.000Z',
      sessionId: INTEGRATION_SESSION_ID, idempotencyKey: 'contact-event', deliveryId: 'contact-delivery',
      data: {
        id: 'message-contact', chatId: INTEGRATION_GROUP_ID, author: memberId, body: 'hello',
        type: 'text', fromMe: false, isGroup: true,
        contact: { pushName: 'Observed sender', privateField: 'must not persist' },
      },
    };
    const runtimeEvents = new RuntimeEventRepository(
      database,
      new GatewayGroupIntentRepository(database),
    );
    const observationIntents = new ContactMessageObservationIntentRepository(database);
    const observer = new ContactMessageObserverService(
      contacts,
      observationIntents,
      true,
    );
    const processor = new WebhookProcessorService(
      database, webhooks, runtimeEvents,
      { updateStatusByOpenWAMessageId: vi.fn() } as unknown as MessageJobRepository,
      observer,
    );

    await webhooks.insert(envelope);
    await processor.process(envelope.idempotencyKey);
    await new ContactMessageObservationTick(observationIntents, observer, {
      enabled: true,
      maxPerTick: 100,
    }).run();

    const member = await pool.query<{ display_name: string; display_name_source: string }>(
      `SELECT display_name, display_name_source FROM group_members
       WHERE session_id = $1 AND group_id = $2 AND participant_id = $3`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, memberId],
    );
    expect(member.rows[0]).toEqual({
      display_name: 'Observed sender', display_name_source: 'OPENWA_PUSH_NAME',
    });
    const runtimeEvent = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM runtime_events WHERE event_id = $1`, [envelope.idempotencyKey],
    );
    expect(JSON.stringify(runtimeEvent.rows[0]?.payload)).not.toContain('Observed sender');
    expect(JSON.stringify(runtimeEvent.rows[0]?.payload)).not.toContain('privateField');
    expect(await pool.query('SELECT 1 FROM contact_message_observation_intents')).toHaveProperty('rowCount', 0);
  });

  it('rolls back projections and preserves raw payload when the atomic commit fails', async () => {
    const envelope: OpenWAWebhookEnvelope = {
      event: 'message.ack', timestamp: '2026-08-11T00:00:00.000Z',
      sessionId: INTEGRATION_SESSION_ID, idempotencyKey: 'atomic-failure', deliveryId: 'atomic-delivery',
      data: { id: 'outbound-message', status: 'delivered', body: 'raw evidence' },
    };
    const runtimeEvents = new RuntimeEventRepository(
      database,
      new GatewayGroupIntentRepository(database),
    );
    const processor = new WebhookProcessorService(
      database,
      webhooks,
      runtimeEvents,
      {
        updateStatusByOpenWAMessageIdWithClient: vi.fn().mockRejectedValue(new Error('projection unavailable')),
      } as unknown as MessageJobRepository,
      new ContactMessageObserverService(
        new ContactRepository(database),
        new ContactMessageObservationIntentRepository(database),
        true,
      ),
    );

    await webhooks.insert(envelope);
    await expect(processor.process(envelope.idempotencyKey)).rejects.toThrow('projection unavailable');

    const state = await pool.query<{
      processing_state: string;
      payload: OpenWAWebhookEnvelope;
      runtime_event_exists: boolean;
    }>(
      `SELECT webhook.processing_state, webhook.payload,
         EXISTS (SELECT 1 FROM runtime_events event WHERE event.event_id = webhook.idempotency_key)
           AS runtime_event_exists
       FROM webhook_events webhook WHERE webhook.idempotency_key = $1`,
      [envelope.idempotencyKey],
    );
    expect(state.rows[0]).toEqual({
      processing_state: 'RETRY',
      payload: envelope,
      runtime_event_exists: false,
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
    const state = await pool.query<{
      processing_state: string;
      processing_error: string;
      dead_at: Date;
      payload: OpenWAWebhookEnvelope;
    }>(
      `SELECT processing_state, processing_error, dead_at, payload
       FROM webhook_events WHERE idempotency_key = $1`,
      [envelope.idempotencyKey],
    );
    expect(state.rows[0]).toMatchObject({ processing_state: 'DEAD', processing_error: 'invalid payload' });
    expect(state.rows[0]!.dead_at).toBeInstanceOf(Date);
    expect(state.rows[0]!.payload).toEqual(envelope);
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

  it('keeps newer session status and restriction observations when events arrive out of order', async () => {
    await seedSendableGroup(pool);
    const runtimeEvents = new RuntimeEventRepository(
      database,
      new GatewayGroupIntentRepository(database),
    );
    const newer = new Date('2026-08-12T00:00:00.000Z');
    const older = new Date('2026-08-11T00:00:00.000Z');

    await runtimeEvents.store({
      eventId: 'new-status', sourceEventType: 'session.status', eventType: 'session.status.changed', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt: newer, payload: { status: 'ready' },
    });
    await runtimeEvents.store({
      eventId: 'old-status', sourceEventType: 'session.status', eventType: 'session.status.changed', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt: older, payload: { status: 'disconnected' },
    });
    await runtimeEvents.store({
      eventId: 'new-restriction', sourceEventType: 'session.restriction',
      eventType: 'session.restriction.changed', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt: newer,
      payload: { active: true, kind: 'RATE_LIMIT', code: 'newer' },
    });
    await runtimeEvents.store({
      eventId: 'old-restriction', sourceEventType: 'session.restriction',
      eventType: 'session.restriction.changed', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt: older, payload: { active: false },
    });
    const gateway = new GatewayRepository(database, new ContactRepository(database));
    await gateway.upsertSession({
      id: INTEGRATION_SESSION_ID,
      name: 'Older snapshot',
      status: 'disconnected',
      engineLoaded: false,
      restriction: null,
      createdAt: older.toISOString(),
      updatedAt: older.toISOString(),
    });

    const state = await pool.query<{
      status: string; restriction: Record<string, unknown>;
      status_observed_at: Date; restriction_observed_at: Date;
    }>(
      `SELECT status, restriction, status_observed_at, restriction_observed_at
       FROM gateway_sessions WHERE id = $1`,
      [INTEGRATION_SESSION_ID],
    );
    expect(state.rows[0]).toMatchObject({
      status: 'ready',
      restriction: { active: true, kind: 'RATE_LIMIT', code: 'newer' },
      status_observed_at: newer,
      restriction_observed_at: newer,
    });
  });

  it('uses first-observation ownership for distinct session events with equal timestamps', async () => {
    await seedSendableGroup(pool);
    const runtimeEvents = new RuntimeEventRepository(
      database,
      new GatewayGroupIntentRepository(database),
    );
    const occurredAt = new Date('2026-08-12T00:00:00.000Z');

    await runtimeEvents.store({
      eventId: 'equal-status-first', sourceEventType: 'session.status',
      eventType: 'session.status.changed', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt, payload: { status: 'ready' },
    });
    await runtimeEvents.store({
      eventId: 'equal-status-second', sourceEventType: 'session.status',
      eventType: 'session.status.changed', eventVersion: 1,
      sessionId: INTEGRATION_SESSION_ID, occurredAt, payload: { status: 'disconnected' },
    });

    const state = await pool.query<{ status: string; status_observed_at: Date }>(
      'SELECT status, status_observed_at FROM gateway_sessions WHERE id = $1', [INTEGRATION_SESSION_ID],
    );
    expect(state.rows[0]).toEqual({ status: 'ready', status_observed_at: occurredAt });
  });

  it('coalesces duplicate and burst group events into one targeted intent', async () => {
    await seedSendableGroup(pool);
    const intents = new GatewayGroupIntentRepository(database);
    const runtimeEvents = new RuntimeEventRepository(
      database,
      intents,
    );
    const processor = new WebhookProcessorService(
      database,
      webhooks,
      runtimeEvents,
      { updateStatusByOpenWAMessageId: vi.fn() } as unknown as MessageJobRepository,
      new ContactMessageObserverService(
        new ContactRepository(database),
        new ContactMessageObservationIntentRepository(database),
        true,
      ),
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
      new GatewayRepository(database, new ContactRepository(database)), new GatewaySyncItemRepository(database), openwa, intents, {} as never,
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
      new GatewayRepository(database, new ContactRepository(database)), new GatewaySyncItemRepository(database), openwa, intents, {} as never,
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
