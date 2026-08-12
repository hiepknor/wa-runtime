import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient, QueryResult } from 'pg';
import { runtimeConfig } from '../../core/config/runtime-config';
import { DatabaseService } from '../../core/database/database.service';

export interface RetentionResult {
  campaignRuns: number;
  messageJobs: number;
  runtimeEvents: number;
  webhookEvents: number;
  syncRuns: number;
}

@Injectable()
export class DataRetentionTick {
  private readonly logger = new Logger(DataRetentionTick.name);
  private readonly config = runtimeConfig();
  private nextRunAt = 0;

  constructor(private readonly database: DatabaseService) {}

  async run(): Promise<void> {
    const now = Date.now();
    if (now < this.nextRunAt) return;
    const result = await this.cleanup();
    this.nextRunAt = Date.now() + this.config.RUNTIME_RETENTION_INTERVAL_MS;
    const deleted = Object.values(result).reduce((total, count) => total + count, 0);
    if (deleted > 0) this.logger.log({ event: 'data.retention.completed', deleted, ...result });
  }

  async cleanup(): Promise<RetentionResult> {
    const cutoff = new Date(Date.now() - this.config.RUNTIME_RETENTION_DAYS * 86_400_000);
    const limit = this.config.RUNTIME_RETENTION_BATCH_SIZE;
    return this.database.transaction(async client => ({
      campaignRuns: await this.deleteCampaignRuns(client, cutoff, limit),
      messageJobs: await this.deleteMessageJobs(client, cutoff, limit),
      runtimeEvents: await this.deleteRuntimeEvents(client, cutoff, limit),
      webhookEvents: await this.deleteWebhookEvents(client, cutoff, limit),
      syncRuns: await this.deleteSyncRuns(client, cutoff, limit),
    }));
  }

  private async deleteCampaignRuns(client: PoolClient, cutoff: Date, limit: number): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT id FROM campaign_runs
         WHERE status IN ('COMPLETED','PARTIAL_FAILED','CANCELLED','FAILED') AND updated_at < $1
         ORDER BY updated_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM campaign_runs cr USING candidates c WHERE cr.id = c.id`,
      [cutoff, limit],
    ));
  }

  private async deleteMessageJobs(client: PoolClient, cutoff: Date, limit: number): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT mj.id FROM message_jobs mj
         WHERE mj.status IN ('ACCEPTED','SENT','DELIVERED','READ','FAILED','UNKNOWN','DRY_RUN_COMPLETED','CANCELLED')
           AND mj.updated_at < $1
           AND NOT EXISTS (SELECT 1 FROM campaign_deliveries cd WHERE cd.message_job_id = mj.id)
         ORDER BY mj.updated_at, mj.id LIMIT $2 FOR UPDATE OF mj SKIP LOCKED
       )
       DELETE FROM message_jobs mj USING candidates c WHERE mj.id = c.id`,
      [cutoff, limit],
    ));
  }

  private async deleteRuntimeEvents(client: PoolClient, cutoff: Date, limit: number): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT event_id FROM runtime_events
         WHERE created_at < $1 ORDER BY created_at, event_id LIMIT $2 FOR UPDATE SKIP LOCKED
       ), deleted_message_events AS (
         DELETE FROM message_events me USING candidates c WHERE me.event_id = c.event_id
       ), deleted_inbound_messages AS (
         DELETE FROM inbound_messages im USING candidates c WHERE im.event_id = c.event_id
       )
       DELETE FROM runtime_events re USING candidates c WHERE re.event_id = c.event_id`,
      [cutoff, limit],
    ));
  }

  private async deleteWebhookEvents(client: PoolClient, cutoff: Date, limit: number): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT id FROM webhook_events
         WHERE processing_state IN ('PROCESSED','DEAD') AND COALESCE(processed_at, received_at) < $1
         ORDER BY COALESCE(processed_at, received_at), id LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM webhook_events we USING candidates c WHERE we.id = c.id`,
      [cutoff, limit],
    ));
  }

  private async deleteSyncRuns(client: PoolClient, cutoff: Date, limit: number): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT id FROM sync_runs
         WHERE status IN ('COMPLETED','FAILED') AND completed_at < $1
         ORDER BY completed_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM sync_runs sr USING candidates c WHERE sr.id = c.id`,
      [cutoff, limit],
    ));
  }

  private count(result: QueryResult): number {
    return result.rowCount ?? 0;
  }
}
