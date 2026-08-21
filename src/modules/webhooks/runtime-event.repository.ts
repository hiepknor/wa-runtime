import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { GatewayGroupIntentRepository } from '../gateway/gateway-group-intent.repository';
import type { RuntimeEvent } from './webhook-normalizer';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';

export interface RuntimeEventLedgerRecord {
  eventVersion: number;
  payload: Record<string, unknown>;
}

export function runtimeEventLedgerRecord(
  event: RuntimeEvent,
  compactMessageBodies = true,
): RuntimeEventLedgerRecord {
  if (!compactMessageBodies || event.eventType !== 'message.received') {
    return { eventVersion: event.eventVersion, payload: event.payload };
  }

  const { body: rawBody, ...metadata } = event.payload;
  const body = typeof rawBody === 'string' ? rawBody : '';
  return {
    eventVersion: 2,
    payload: {
      ...metadata,
      bodyBytes: Buffer.byteLength(body, 'utf8'),
      bodySha256: createHash('sha256').update(body).digest('hex'),
    },
  };
}

@Injectable()
export class RuntimeEventRepository {
  private readonly logger = new Logger(RuntimeEventRepository.name);
  constructor(
    private readonly database: DatabaseService,
    private readonly groupIntents: GatewayGroupIntentRepository,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async store(event: RuntimeEvent): Promise<void> {
    await this.database.transaction(client => this.storeInTransaction(client, event));
  }

  async storeInTransaction(client: PoolClient, event: RuntimeEvent): Promise<boolean> {
    const ledger = runtimeEventLedgerRecord(event, this.config.RUNTIME_COMPACT_EVENT_PAYLOAD_ENABLED);
    const inserted = await client.query(
      `INSERT INTO runtime_events
           (event_id, source_event_type, event_type, event_version, session_id, occurred_at, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (event_id) DO NOTHING`,
      [event.eventId, event.sourceEventType, event.eventType, ledger.eventVersion,
        event.sessionId, event.occurredAt, JSON.stringify(ledger.payload)],
    );
    if (inserted.rowCount !== 1) {
      const existing = await client.query<{
        source_event_type: string;
        event_type: string;
        session_id: string;
        occurred_at: Date;
      }>(
        `SELECT source_event_type, event_type, session_id, occurred_at
         FROM runtime_events WHERE event_id = $1`,
        [event.eventId],
      );
      const row = existing.rows[0];
      if (!row || row.source_event_type !== event.sourceEventType || row.event_type !== event.eventType
        || row.session_id !== event.sessionId || row.occurred_at.valueOf() !== event.occurredAt.valueOf()) {
        throw new Error(`Runtime event idempotency collision: ${event.eventId}`);
      }
      return false;
    }

    if (event.eventType === 'message.received' && event.payload.isGroup === true && event.payload.messageId) {
      await client.query(
        `INSERT INTO inbound_messages
           (session_id, message_id, group_id, sender_id, body, message_type, from_me, received_at, event_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (session_id, message_id) DO NOTHING`,
        [event.sessionId, event.payload.messageId, event.payload.groupId, event.payload.senderId,
          event.payload.body, event.payload.messageType, event.payload.fromMe, event.occurredAt, event.eventId],
      );
    }

    if (['message.ack', 'message.sent', 'message.failed'].includes(event.eventType) && event.payload.messageId) {
      await client.query(
        `INSERT INTO message_events
           (event_id, session_id, message_id, group_id, event_type, delivery_status, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (event_id) DO NOTHING`,
        [event.eventId, event.sessionId, event.payload.messageId, event.payload.groupId,
          event.eventType, event.payload.deliveryStatus, event.occurredAt],
      );
    }

    if (event.eventType === 'session.status.changed') {
      await client.query(
        `UPDATE gateway_sessions SET status = $2, status_observed_at = $3,
           gateway_updated_at = GREATEST(gateway_updated_at, $3), synced_at = now(), updated_at = now()
         WHERE id = $1 AND status_observed_at < $3`,
        [event.sessionId, event.payload.status, event.occurredAt],
      );
    }

    if (event.eventType === 'session.restriction.changed') {
      const restriction = event.payload.active === true ? event.payload : null;
      await client.query(
        `UPDATE gateway_sessions SET restriction = $2::jsonb, restriction_observed_at = $3,
           gateway_updated_at = GREATEST(gateway_updated_at, $3), synced_at = now(), updated_at = now()
         WHERE id = $1 AND restriction_observed_at < $3`,
        [event.sessionId, restriction === null ? null : JSON.stringify(restriction), event.occurredAt],
      );
    }

    if (['group.join', 'group.leave', 'group.update'].includes(event.eventType) && event.payload.groupId
      && this.config.OPENWA_ALLOWED_SESSION_IDS.includes(event.sessionId)) {
      const groupId = String(event.payload.groupId);
      const sessionExists = await client.query(
        `SELECT 1 FROM gateway_sessions WHERE id = $1`,
        [event.sessionId],
      );
      if (sessionExists.rowCount !== 1) return true;
      const scheduled = await this.groupIntents.scheduleInTransaction(
        client,
        event.sessionId,
        groupId,
        event.eventType,
      );
      await client.query(
        `UPDATE gateway_groups SET send_capability = 'UNKNOWN',
           send_capability_reason = 'GROUP_CHANGED', capability_invalidated_at = now(),
           capability_revision = capability_revision + 1, updated_at = now()
         WHERE session_id = $1 AND id = $2 AND is_active = true`,
        [event.sessionId, groupId],
      );
      if (scheduled.created) {
        this.logger.log({
          event: 'gateway.group_reconciliation.intent_created',
          sessionId: event.sessionId, source: 'WEBHOOK',
        });
      }
    }
    return true;
  }
}
