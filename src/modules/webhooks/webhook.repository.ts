import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';

export interface OpenWAWebhookEnvelope {
  event: string;
  timestamp: string;
  sessionId: string;
  idempotencyKey: string;
  deliveryId: string;
  data: Record<string, unknown>;
}

export interface WebhookDispatchItem {
  idempotencyKey: string;
}

@Injectable()
export class WebhookRepository {
  constructor(private readonly database: DatabaseService) {}

  async insert(envelope: OpenWAWebhookEnvelope): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO webhook_events
         (idempotency_key, delivery_id, event_type, session_id, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        envelope.idempotencyKey,
        envelope.deliveryId,
        envelope.event,
        envelope.sessionId,
        JSON.stringify(envelope),
      ],
    );
    return result.rowCount === 1;
  }

  async find(idempotencyKey: string): Promise<OpenWAWebhookEnvelope | null> {
    const result = await this.database.query<{ payload: OpenWAWebhookEnvelope }>(
      'SELECT payload FROM webhook_events WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    return result.rows[0]?.payload ?? null;
  }

  async listDispatchable(limit: number): Promise<WebhookDispatchItem[]> {
    const result = await this.database.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM webhook_events
       WHERE processing_state IN ('PENDING', 'RETRY') AND next_attempt_at <= now()
       ORDER BY next_attempt_at, received_at LIMIT $1`,
      [limit],
    );
    return result.rows.map(row => ({ idempotencyKey: row.idempotency_key }));
  }

  async claimForProcessing(idempotencyKey: string): Promise<OpenWAWebhookEnvelope | null> {
    const result = await this.database.query<{ payload: OpenWAWebhookEnvelope }>(
      `UPDATE webhook_events SET processing_state = 'PROCESSING',
         attempt_count = attempt_count + 1, last_attempt_at = now(),
         lease_expires_at = now() + interval '2 minutes', processing_error = NULL
       WHERE idempotency_key = $1
         AND processing_state IN ('PENDING', 'RETRY')
         AND next_attempt_at <= now()
       RETURNING payload`,
      [idempotencyKey],
    );
    return result.rows[0]?.payload ?? null;
  }

  async recoverExpiredProcessing(): Promise<number> {
    const result = await this.database.query(
      `UPDATE webhook_events SET processing_state = 'RETRY', lease_expires_at = NULL,
         next_attempt_at = now(), processing_error = 'Recovered expired processing lease'
       WHERE processing_state = 'PROCESSING' AND lease_expires_at < now()`,
    );
    return result.rowCount ?? 0;
  }

  async markProcessed(idempotencyKey: string, error?: string): Promise<void> {
    await this.database.query(
      `UPDATE webhook_events
       SET processing_state = 'PROCESSED', processed_at = now(), processing_error = $2,
         lease_expires_at = NULL
       WHERE idempotency_key = $1`,
      [idempotencyKey, error ?? null],
    );
  }

  async markFailed(idempotencyKey: string, error: string): Promise<'RETRY' | 'DEAD'> {
    const result = await this.database.query<{ processing_state: 'RETRY' | 'DEAD' }>(
      `UPDATE webhook_events SET
         processing_state = CASE WHEN attempt_count >= 5 THEN 'DEAD' ELSE 'RETRY' END,
         processing_error = $2,
         lease_expires_at = NULL,
         next_attempt_at = CASE WHEN attempt_count >= 5 THEN next_attempt_at
           ELSE now() + LEAST(300, 5 * power(2, attempt_count - 1)) * interval '1 second' END,
         dead_at = CASE WHEN attempt_count >= 5 THEN now() ELSE dead_at END
       WHERE idempotency_key = $1 AND processing_state = 'PROCESSING'
       RETURNING processing_state`,
      [idempotencyKey, error],
    );
    return result.rows[0]?.processing_state ?? 'DEAD';
  }
}
