import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';

export interface ContactMessageObservationIntent {
  eventId: string;
  sessionId: string;
  senderId: string;
  pushName: string;
  observedAt: Date;
  leaseToken: string;
}

export type ContactMessageObservationFailure = 'RETRY' | 'DEAD' | 'LOST_OWNERSHIP';

@Injectable()
export class ContactMessageObservationIntentRepository {
  constructor(private readonly database: DatabaseService) {}

  async enqueue(
    client: PoolClient,
    input: Omit<ContactMessageObservationIntent, 'leaseToken'>,
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO contact_message_observation_intents
         (event_id, session_id, sender_id, push_name, observed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id) DO NOTHING`,
      [input.eventId, input.sessionId, input.senderId, input.pushName, input.observedAt],
    );
    return result.rowCount === 1;
  }

  async recoverExpired(): Promise<number> {
    const result = await this.database.query(
      `UPDATE contact_message_observation_intents SET
         processing_state = CASE WHEN attempt_count >= 10 THEN 'DEAD' ELSE 'RETRY' END,
         next_attempt_at = CASE WHEN attempt_count >= 10 THEN next_attempt_at ELSE now() END,
         lease_token = NULL, lease_expires_at = NULL,
         processing_error = 'Recovered expired processing lease', updated_at = now()
       WHERE processing_state = 'PROCESSING' AND lease_expires_at < now()`,
    );
    return result.rowCount ?? 0;
  }

  async claim(limit: number): Promise<ContactMessageObservationIntent[]> {
    return this.database.transaction(async client => {
      const result = await client.query<{
        event_id: string;
        session_id: string;
        sender_id: string;
        push_name: string;
        observed_at: Date;
        lease_token: string;
      }>(
        `WITH candidates AS (
           SELECT event_id FROM contact_message_observation_intents
           WHERE processing_state IN ('PENDING', 'RETRY') AND next_attempt_at <= now()
           ORDER BY next_attempt_at, created_at LIMIT $1 FOR UPDATE SKIP LOCKED
         )
         UPDATE contact_message_observation_intents intent SET
           processing_state = 'PROCESSING', attempt_count = attempt_count + 1,
           lease_token = gen_random_uuid(), lease_expires_at = now() + interval '2 minutes',
           processing_error = NULL, updated_at = now()
         FROM candidates WHERE intent.event_id = candidates.event_id
         RETURNING intent.event_id, intent.session_id, intent.sender_id, intent.push_name,
           intent.observed_at, intent.lease_token`,
        [limit],
      );
      return result.rows.map(row => ({
        eventId: row.event_id,
        sessionId: row.session_id,
        senderId: row.sender_id,
        pushName: row.push_name,
        observedAt: row.observed_at,
        leaseToken: row.lease_token,
      }));
    });
  }

  async complete(eventId: string, leaseToken: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM contact_message_observation_intents
       WHERE event_id = $1 AND processing_state = 'PROCESSING' AND lease_token = $2`,
      [eventId, leaseToken],
    );
    return result.rowCount === 1;
  }

  async fail(eventId: string, leaseToken: string, error: string): Promise<ContactMessageObservationFailure> {
    const result = await this.database.query<{ processing_state: 'RETRY' | 'DEAD' }>(
      `UPDATE contact_message_observation_intents SET
         processing_state = CASE WHEN attempt_count >= 10 THEN 'DEAD' ELSE 'RETRY' END,
         next_attempt_at = CASE WHEN attempt_count >= 10 THEN next_attempt_at
           ELSE now() + LEAST(900, 5 * power(2, attempt_count - 1)) * interval '1 second' END,
         lease_token = NULL, lease_expires_at = NULL, processing_error = $3, updated_at = now()
       WHERE event_id = $1 AND processing_state = 'PROCESSING' AND lease_token = $2
       RETURNING processing_state`,
      [eventId, leaseToken, error],
    );
    return result.rows[0]?.processing_state ?? 'LOST_OWNERSHIP';
  }
}
