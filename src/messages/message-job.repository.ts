import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import type { MessageJob, MessageJobStatus } from './message-job.types';

interface MessageJobRow {
  id: string;
  idempotency_key: string;
  session_id: string;
  recipient_id: string;
  payload: { text: string };
  scheduled_at: Date;
  status: MessageJobStatus;
  dry_run: boolean;
  attempt_count: number;
  openwa_message_id: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const map = (row: MessageJobRow): MessageJob => ({
  id: row.id,
  idempotencyKey: row.idempotency_key,
  sessionId: row.session_id,
  recipientId: row.recipient_id,
  payload: row.payload,
  scheduledAt: row.scheduled_at,
  status: row.status,
  dryRun: row.dry_run,
  attemptCount: row.attempt_count,
  openwaMessageId: row.openwa_message_id,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

@Injectable()
export class MessageJobRepository {
  constructor(private readonly database: DatabaseService) {}

  async create(input: {
    idempotencyKey: string;
    sessionId: string;
    recipientId: string;
    text: string;
    scheduledAt: Date;
    dryRun: boolean;
  }): Promise<{ job: MessageJob; created: boolean }> {
    const inserted = await this.database.query<MessageJobRow>(
      `INSERT INTO message_jobs
         (idempotency_key, session_id, recipient_id, payload, scheduled_at, dry_run)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [input.idempotencyKey, input.sessionId, input.recipientId, JSON.stringify({ text: input.text }), input.scheduledAt, input.dryRun],
    );
    if (inserted.rows[0]) return { job: map(inserted.rows[0]), created: true };

    const existing = await this.database.query<MessageJobRow>(
      'SELECT * FROM message_jobs WHERE idempotency_key = $1',
      [input.idempotencyKey],
    );
    return { job: map(existing.rows[0]!), created: false };
  }

  async find(id: string): Promise<MessageJob | null> {
    const result = await this.database.query<MessageJobRow>('SELECT * FROM message_jobs WHERE id = $1', [id]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async claimDue(limit: number): Promise<MessageJob[]> {
    return this.database.transaction(async client => {
      const result = await client.query<MessageJobRow>(
        `SELECT * FROM message_jobs
         WHERE status = 'SCHEDULED' AND scheduled_at <= now()
         ORDER BY scheduled_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [limit],
      );
      if (!result.rows.length) return [];
      const ids = result.rows.map(row => row.id);
      await client.query(
        `UPDATE message_jobs SET status = 'QUEUED', updated_at = now() WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      return result.rows.map(row => map({ ...row, status: 'QUEUED' }));
    });
  }

  async markProcessing(id: string): Promise<MessageJob | null> {
    const result = await this.database.query<MessageJobRow>(
      `UPDATE message_jobs
       SET status = 'PROCESSING', attempt_count = attempt_count + 1, updated_at = now()
       WHERE id = $1 AND status = 'QUEUED'
       RETURNING *`,
      [id],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async resetQueued(id: string, error: string): Promise<void> {
    await this.database.query(
      `UPDATE message_jobs
       SET status = 'SCHEDULED', last_error = $2, updated_at = now()
       WHERE id = $1 AND status = 'QUEUED'`,
      [id, error],
    );
  }

  async recoverStaleQueued(): Promise<number> {
    const result = await this.database.query(
      `UPDATE message_jobs
       SET status = 'SCHEDULED', last_error = 'Recovered stale queued job', updated_at = now()
       WHERE status = 'QUEUED' AND updated_at < now() - interval '2 minutes'`,
    );
    return result.rowCount ?? 0;
  }

  async updateResult(
    client: PoolClient,
    id: string,
    status: MessageJobStatus,
    options: { openwaMessageId?: string; error?: string; response?: unknown } = {},
  ): Promise<void> {
    const updated = await client.query<MessageJobRow>(
      `UPDATE message_jobs
       SET status = $2, openwa_message_id = COALESCE($3, openwa_message_id), last_error = $4, updated_at = now()
       WHERE id = $1
       RETURNING attempt_count`,
      [id, status, options.openwaMessageId ?? null, options.error ?? null],
    );
    const attempt = updated.rows[0]?.attempt_count;
    if (attempt !== undefined) {
      await client.query(
        `INSERT INTO message_attempts (message_job_id, attempt_number, outcome, response, error)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (message_job_id, attempt_number) DO NOTHING`,
        [id, attempt, status, JSON.stringify(options.response ?? null), options.error ?? null],
      );
    }
  }

  async updateStatusByOpenWAMessageId(openwaMessageId: string, status: MessageJobStatus): Promise<void> {
    await this.database.query(
      `UPDATE message_jobs SET status = $2, updated_at = now()
       WHERE openwa_message_id = $1
         AND status NOT IN ('FAILED', 'CANCELLED', 'DRY_RUN_COMPLETED')`,
      [openwaMessageId, status],
    );
  }
}
