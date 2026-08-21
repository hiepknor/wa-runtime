import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { runtimeConfig } from '../../src/core/config/runtime-config';
import { DataRetentionTick } from '../../src/modules/orchestration/data-retention.tick';
import {
  INTEGRATION_GROUP_ID,
  INTEGRATION_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
  seedSendableGroup,
} from '../support/integration-database';

describe('data retention', () => {
  let pool: Pool;
  let database: DatabaseService;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await seedSendableGroup(pool);
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
    await pool.end();
  });

  it('deletes old terminal graphs and preserves active work', async () => {
    const old = new Date(Date.now() - 100 * 86_400_000);
    await pool.query(
      `INSERT INTO message_jobs
         (idempotency_scope, idempotency_key, request_hash, session_id, recipient_id, payload,
          scheduled_at, status, dry_run, updated_at)
       VALUES
         ('runtime-api','old-terminal',$1,$2,$3,'{"text":"old"}',now(),'FAILED',false,$4),
         ('runtime-api','old-active',$1,$2,$3,'{"text":"active"}',now(),'PROCESSING',false,$4)`,
      ['a'.repeat(64), INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, old],
    );
    await pool.query(
      `INSERT INTO runtime_events
         (event_id, source_event_type, event_type, session_id, occurred_at, payload, created_at)
       VALUES ('old-event','message','message.received',$1,$2,'{}',$2),
              ('new-event','message','message.received',$1,now(),'{}',now())`,
      [INTEGRATION_SESSION_ID, old],
    );
    await pool.query(
      `INSERT INTO inbound_messages
         (session_id, message_id, group_id, sender_id, body, message_type, received_at, event_id)
       VALUES ($1,'old-message',$2,'sender','body','text',$3,'old-event')`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, old],
    );
    await pool.query(
      `INSERT INTO webhook_events
         (idempotency_key, event_type, payload, processing_state, processed_at, received_at)
       VALUES ('old-webhook','message','{}','PROCESSED',$1,$1),
              ('active-webhook','message','{}','PROCESSING',NULL,$1)`,
      [old],
    );
    await pool.query(
      `INSERT INTO gateway_sync_fences (session_id, current_epoch) VALUES ($1, 1)`,
      [INTEGRATION_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO sync_runs
         (session_id, sync_type, status, requested_at, completed_at, sync_epoch, lease_token, lease_expires_at)
       VALUES ($1,'full','COMPLETED',$2,$2,NULL,NULL,NULL),
              ($1,'full','RUNNING',$2,NULL,1,gen_random_uuid(),now() + interval '2 minutes')`,
      [INTEGRATION_SESSION_ID, old],
    );
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (session_id, name, payload) VALUES ($1,'retention','{"text":"hello"}') RETURNING id`,
      [INTEGRATION_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO campaign_runs
         (campaign_id, session_id, idempotency_key, execution_mode, status, payload_snapshot, scheduled_at, updated_at)
       VALUES ($1,$2,$3,'DRY_RUN','COMPLETED','{"text":"hello"}',now(),$4),
              ($1,$2,$5,'DRY_RUN','RUNNING','{"text":"hello"}',now(),$4)`,
      [campaign.rows[0]!.id, INTEGRATION_SESSION_ID, randomUUID(), old, randomUUID()],
    );

    const result = await new DataRetentionTick(database).cleanup();

    expect(result).toEqual({
      campaignRuns: 1, messageJobs: 1, inboundMessages: 0, runtimeEvents: 1, webhookEvents: 1, syncRuns: 1,
      contactObservations: 0,
      batches: 1, capacityExhausted: false,
    });
    await expectCount('message_jobs', 1);
    await expectCount('runtime_events', 1);
    await expectCount('inbound_messages', 0);
    await expectCount('webhook_events', 1);
    await expectCount('sync_runs', 1);
    await expectCount('campaign_runs', 1);
  });

  it('drains more than one delete batch without one long transaction', async () => {
    const old = new Date(Date.now() - 100 * 86_400_000);
    await pool.query(
      `INSERT INTO runtime_events
         (event_id, source_event_type, event_type, session_id, occurred_at, payload, created_at)
       SELECT 'old-batch-' || value, 'message', 'message.received', $1, $2, '{}', $2
       FROM generate_series(1, 250) value`,
      [INTEGRATION_SESSION_ID, old],
    );

    const result = await new DataRetentionTick(database).cleanup({ batchSize: 100, maxBatches: 10 });

    expect(result).toMatchObject({ runtimeEvents: 250, batches: 3, capacityExhausted: false });
    await expectCount('runtime_events', 0);
  });

  it('uses shorter raw-webhook and normalized-event lifetimes than operational history', async () => {
    const tenDaysOld = new Date(Date.now() - 10 * 86_400_000);
    const fortyDaysOld = new Date(Date.now() - 40 * 86_400_000);
    await pool.query(
      `INSERT INTO runtime_events
         (event_id, source_event_type, event_type, session_id, occurred_at, payload, created_at)
       VALUES ('ten-day-event','message','message.received',$1,$2,'{}',$2),
              ('forty-day-event','message','message.received',$1,$3,'{}',$3)`,
      [INTEGRATION_SESSION_ID, tenDaysOld, fortyDaysOld],
    );
    await pool.query(
      `INSERT INTO webhook_events
         (idempotency_key, event_type, payload, processing_state, processed_at, received_at)
       VALUES ('ten-day-webhook','message','{}','PROCESSED',$1,$1)`,
      [tenDaysOld],
    );
    await pool.query(
      `INSERT INTO message_jobs
         (idempotency_scope, idempotency_key, request_hash, session_id, recipient_id, payload,
          scheduled_at, status, dry_run, updated_at)
       VALUES ('runtime-api','forty-day-job',$1,$2,$3,'{"text":"old"}',now(),'FAILED',false,$4)`,
      ['a'.repeat(64), INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, fortyDaysOld],
    );

    const result = await new DataRetentionTick(database).cleanup();

    expect(result).toMatchObject({ webhookEvents: 1, runtimeEvents: 1, messageJobs: 0 });
    expect((await pool.query('SELECT event_id FROM runtime_events')).rows).toEqual([
      { event_id: 'ten-day-event' },
    ]);
    await expectCount('message_jobs', 1);
  });

  it('expires inbox bodies independently while preserving their normalized event ledger', async () => {
    const tenDaysOld = new Date(Date.now() - 10 * 86_400_000);
    await pool.query(
      `INSERT INTO runtime_events
         (event_id, source_event_type, event_type, session_id, occurred_at, payload, created_at)
       VALUES ('inbox-retention-event','message','message.received',$1,$2,'{}',$2)`,
      [INTEGRATION_SESSION_ID, tenDaysOld],
    );
    await pool.query(
      `INSERT INTO inbound_messages
         (session_id, message_id, group_id, sender_id, body, message_type, received_at, event_id, created_at)
       VALUES ($1,'inbox-retention-message',$2,'sender','body','text',$3,'inbox-retention-event',$3)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, tenDaysOld],
    );

    const result = await new DataRetentionTick(database, {
      ...runtimeConfig(),
      RUNTIME_INBOX_RETENTION_DAYS: 7,
      RUNTIME_EVENT_RETENTION_DAYS: 30,
    }).cleanup();

    expect(result).toMatchObject({ inboundMessages: 1, runtimeEvents: 0 });
    await expectCount('inbound_messages', 0);
    await expectCount('runtime_events', 1);
  });

  it('reports remaining capacity pressure when the configured batch cap is reached', async () => {
    const old = new Date(Date.now() - 100 * 86_400_000);
    await pool.query(
      `INSERT INTO runtime_events
         (event_id, source_event_type, event_type, session_id, occurred_at, payload, created_at)
       SELECT 'capped-batch-' || value, 'message', 'message.received', $1, $2, '{}', $2
       FROM generate_series(1, 250) value`,
      [INTEGRATION_SESSION_ID, old],
    );

    const result = await new DataRetentionTick(database).cleanup({ batchSize: 100, maxBatches: 2 });

    expect(result).toMatchObject({ runtimeEvents: 200, batches: 2, capacityExhausted: true });
    await expectCount('runtime_events', 50);
  });

  it('uses bounded autovacuum thresholds for high-churn retained tables', async () => {
    const result = await pool.query<{ relname: string; reloptions: string[] }>(
      `SELECT relation.relname, relation.reloptions
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname IN (
           'webhook_events', 'runtime_events', 'inbound_messages', 'contact_observations'
         )
       ORDER BY relation.relname`,
    );

    expect(result.rows).toHaveLength(4);
    for (const row of result.rows) {
      expect(new Set(row.reloptions)).toEqual(new Set([
        'autovacuum_vacuum_threshold=10000',
        'autovacuum_vacuum_scale_factor=0.05',
        'autovacuum_analyze_threshold=10000',
        'autovacuum_analyze_scale_factor=0.02',
      ]));
    }
  });

  it('indexes active-work and protected-observation retention guards', async () => {
    const result = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname IN (
         'idx_contact_projection_work_active_session',
         'idx_resolved_contact_clusters_name_observation'
       )
       ORDER BY indexname`,
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      indexname: 'idx_contact_projection_work_active_session',
    });
    expect(result.rows[0]!.indexdef).toContain('(session_id) WHERE (status = ANY');
    expect(result.rows[1]).toMatchObject({
      indexname: 'idx_resolved_contact_clusters_name_observation',
    });
    expect(result.rows[1]!.indexdef).toContain('(session_id, contact_name_observation_id)');
    expect(result.rows[1]!.indexdef).toContain('contact_name_observation_id IS NOT NULL');
  });

  it('compacts old push-name history only after derived contact work is idle', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000);
    const identity = await pool.query<{ id: string }>(
      `INSERT INTO observed_contact_identities (session_id, identity_type, identity_value)
       VALUES ($1, 'LID', 'retention-probe@lid') RETURNING id`,
      [INTEGRATION_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO contact_observations
         (session_id, identity_id, observation_source, observation_scope, name_value,
          source_observed_at, source_observation_key, created_at)
       VALUES ($1, $2, 'OPENWA_PUSH_NAME', 'IDENTITY', 'Older name', $3, 'old-name', $3),
              ($1, $2, 'OPENWA_PUSH_NAME', 'IDENTITY', 'Current name', now(), 'new-name', now())`,
      [INTEGRATION_SESSION_ID, identity.rows[0]!.id, old],
    );
    await pool.query(
      `INSERT INTO contact_projection_work (session_id, identity_id, status)
       VALUES ($1, $2, 'PENDING')`,
      [INTEGRATION_SESSION_ID, identity.rows[0]!.id],
    );

    const guarded = await new DataRetentionTick(database).cleanup();
    expect(guarded.contactObservations).toBe(0);
    await pool.query(
      `UPDATE contact_projection_work SET status = 'IDLE' WHERE session_id = $1 AND identity_id = $2`,
      [INTEGRATION_SESSION_ID, identity.rows[0]!.id],
    );

    const compacted = await new DataRetentionTick(database).cleanup();
    expect(compacted.contactObservations).toBe(1);
    const retained = await pool.query<{ name_value: string }>(
      `SELECT name_value FROM contact_observations
       WHERE session_id = $1 AND identity_id = $2`,
      [INTEGRATION_SESSION_ID, identity.rows[0]!.id],
    );
    expect(retained.rows).toEqual([{ name_value: 'Current name' }]);
  });

  async function expectCount(table: string, expected: number): Promise<void> {
    const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
    expect(Number(result.rows[0]!.count)).toBe(expected);
  }
});
