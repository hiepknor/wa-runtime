import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SessionStateCacheService } from '../campaigns/session-state-cache.service';
import type { RuntimeEvent } from './webhook-normalizer';

@Injectable()
export class RuntimeEventRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessionStates: SessionStateCacheService,
  ) {}

  async store(event: RuntimeEvent): Promise<void> {
    let invalidateSessionCache = false;
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
        invalidateSessionCache = true;
        await client.query(
          `UPDATE gateway_sessions SET status = $2, gateway_updated_at = GREATEST(gateway_updated_at, $3),
             synced_at = now(), updated_at = now() WHERE id = $1`,
          [event.sessionId, event.payload.status, event.occurredAt],
        );
      }


      if (['group.join', 'group.leave', 'group.update'].includes(event.eventType) && event.payload.groupId) {
        await client.query(
          `UPDATE gateway_groups SET send_capability = 'UNKNOWN',
             send_capability_reason = 'GROUP_CHANGED', capability_invalidated_at = now(),
             capability_revision = capability_revision + 1, updated_at = now()
           WHERE session_id = $1 AND id = $2 AND is_active = true`,
          [event.sessionId, event.payload.groupId],
        );
      }
    });
    if (invalidateSessionCache) await this.sessionStates.invalidate(event.sessionId);
  }
}
