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

  async markProcessed(idempotencyKey: string, error?: string): Promise<void> {
    await this.database.query(
      `UPDATE webhook_events
       SET processed_at = now(), processing_error = $2
       WHERE idempotency_key = $1`,
      [idempotencyKey, error ?? null],
    );
  }
}
