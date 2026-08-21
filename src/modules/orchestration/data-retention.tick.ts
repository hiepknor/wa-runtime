import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PoolClient, QueryResult } from 'pg';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { DatabaseService } from '../../core/database/database.service';

export interface RetentionResult {
  campaignRuns: number;
  messageJobs: number;
  inboundMessages: number;
  runtimeEvents: number;
  webhookEvents: number;
  syncRuns: number;
  contactObservations: number;
  batches: number;
  capacityExhausted: boolean;
}

interface RetentionOptions {
  batchSize?: number;
  maxBatches?: number;
  timeBudgetMs?: number;
  now?: Date;
}

@Injectable()
export class DataRetentionTick {
  private readonly logger = new Logger(DataRetentionTick.name);
  constructor(
    private readonly database: DatabaseService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async run(): Promise<void> {
    const started = performance.now();
    const result = await this.cleanup();
    const deleted = result.campaignRuns + result.messageJobs + result.inboundMessages + result.runtimeEvents
      + result.webhookEvents + result.syncRuns + result.contactObservations;
    this.logger.log({
      event: 'data.retention.completed', deleted, durationMs: Math.round(performance.now() - started), ...result,
    });
  }

  async cleanup(options: RetentionOptions = {}): Promise<RetentionResult> {
    const now = options.now ?? new Date();
    const operationalCutoff = new Date(now.valueOf() - this.config.RUNTIME_RETENTION_DAYS * 86_400_000);
    const eventCutoff = new Date(now.valueOf() - this.config.RUNTIME_EVENT_RETENTION_DAYS * 86_400_000);
    const inboxCutoff = new Date(now.valueOf() - this.config.RUNTIME_INBOX_RETENTION_DAYS * 86_400_000);
    const webhookCutoff = new Date(now.valueOf() - this.config.RUNTIME_RAW_WEBHOOK_RETENTION_DAYS * 86_400_000);
    const contactObservationCutoff = new Date(
      now.valueOf() - this.config.CONTACT_MESSAGE_OBSERVATION_RETENTION_DAYS * 86_400_000,
    );
    const limit = options.batchSize ?? this.config.RUNTIME_RETENTION_BATCH_SIZE;
    const maxBatches = options.maxBatches ?? this.config.RUNTIME_RETENTION_MAX_BATCHES_PER_RUN;
    const deadline = performance.now() + (options.timeBudgetMs ?? this.config.RUNTIME_RETENTION_TIME_BUDGET_MS);
    const total: RetentionResult = {
      campaignRuns: 0, messageJobs: 0, inboundMessages: 0, runtimeEvents: 0, webhookEvents: 0, syncRuns: 0,
      contactObservations: 0,
      batches: 0, capacityExhausted: false,
    };
    let drained = false;

    for (let batch = 0; batch < maxBatches; batch += 1) {
      if (performance.now() >= deadline) {
        total.capacityExhausted = true;
        break;
      }
      const current = await this.database.transaction(async client => ({
        campaignRuns: await this.deleteCampaignRuns(client, operationalCutoff, limit),
        messageJobs: await this.deleteMessageJobs(client, operationalCutoff, limit),
        inboundMessages: await this.deleteInboundMessages(client, inboxCutoff, limit),
        runtimeEvents: await this.deleteRuntimeEvents(client, eventCutoff, limit),
        webhookEvents: await this.deleteWebhookEvents(client, webhookCutoff, limit),
        syncRuns: await this.deleteSyncRuns(client, operationalCutoff, limit),
        contactObservations: await this.deleteRedundantContactObservations(
          client,
          contactObservationCutoff,
          limit,
        ),
      }));
      total.batches += 1;
      total.campaignRuns += current.campaignRuns;
      total.messageJobs += current.messageJobs;
      total.inboundMessages += current.inboundMessages;
      total.runtimeEvents += current.runtimeEvents;
      total.webhookEvents += current.webhookEvents;
      total.syncRuns += current.syncRuns;
      total.contactObservations += current.contactObservations;
      if (Object.values(current).every(count => count < limit)) {
        drained = true;
        break;
      }
    }
    if (!drained && total.batches === maxBatches) total.capacityExhausted = true;
    return total;
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

  private async deleteInboundMessages(client: PoolClient, cutoff: Date, limit: number): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT event_id FROM inbound_messages
         WHERE created_at < $1 ORDER BY created_at, event_id LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM inbound_messages message USING candidates
       WHERE message.event_id = candidates.event_id`,
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

  private async deleteRedundantContactObservations(
    client: PoolClient,
    cutoff: Date,
    limit: number,
  ): Promise<number> {
    return this.count(await client.query(
      `WITH candidates AS (
         SELECT observation.session_id, observation.id
         FROM contact_observations observation
         WHERE observation.source_generation IS NULL
           AND observation.observation_source = 'OPENWA_PUSH_NAME'
           AND observation.created_at < $1
           AND EXISTS (
             SELECT 1 FROM contact_observations newer
             WHERE newer.session_id = observation.session_id
               AND newer.identity_id = observation.identity_id
               AND newer.observation_source = observation.observation_source
               AND newer.source_generation IS NULL
               AND (newer.source_observed_at, newer.source_observation_key, newer.id)
                 > (observation.source_observed_at, observation.source_observation_key, observation.id)
           )
           AND NOT EXISTS (
             SELECT 1 FROM contact_resolution_runs resolution
             WHERE resolution.session_id = observation.session_id
               AND resolution.status IN ('PENDING', 'RUNNING', 'RETRY')
           )
           AND NOT EXISTS (
             SELECT 1 FROM contact_projection_work work
             WHERE work.session_id = observation.session_id
               AND work.status IN ('PENDING', 'RUNNING', 'RETRY')
           )
           AND NOT EXISTS (
             SELECT 1 FROM resolved_contact_clusters cluster
             WHERE cluster.session_id = observation.session_id
               AND cluster.contact_name_observation_id = observation.id
           )
         ORDER BY observation.created_at, observation.id
         LIMIT $2 FOR UPDATE OF observation SKIP LOCKED
       )
       DELETE FROM contact_observations observation USING candidates
       WHERE observation.session_id = candidates.session_id AND observation.id = candidates.id`,
      [cutoff, limit],
    ));
  }

  private count(result: QueryResult): number {
    return result.rowCount ?? 0;
  }
}
