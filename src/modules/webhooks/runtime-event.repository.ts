import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { GatewayGroupIntentRepository } from '../gateway/gateway-group-intent.repository';
import type { RuntimeEvent } from './webhook-normalizer';
import { runtimeConfig } from '../../core/config/runtime-config';

@Injectable()
export class RuntimeEventRepository {
  private readonly logger = new Logger(RuntimeEventRepository.name);
  private readonly config = runtimeConfig();
  constructor(
    private readonly database: DatabaseService,
    private readonly groupIntents: GatewayGroupIntentRepository,
  ) {}

  async store(event: RuntimeEvent): Promise<void> {
    await this.database.transaction(async client => {
      const inserted = await client.query(
        `INSERT INTO runtime_events
           (event_id, source_event_type, event_type, event_version, session_id, occurred_at, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (event_id) DO NOTHING`,
        [event.eventId, event.sourceEventType, event.eventType, event.eventVersion,
          event.sessionId, event.occurredAt, JSON.stringify(event.payload)],
      );
      if (inserted.rowCount !== 1) return;

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
        if (sessionExists.rowCount !== 1) return;
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
    });
  }
}
