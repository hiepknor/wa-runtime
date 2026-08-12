import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
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

    expect(result).toEqual({ campaignRuns: 1, messageJobs: 1, runtimeEvents: 1, webhookEvents: 1, syncRuns: 1 });
    await expectCount('message_jobs', 1);
    await expectCount('runtime_events', 1);
    await expectCount('inbound_messages', 0);
    await expectCount('webhook_events', 1);
    await expectCount('sync_runs', 1);
    await expectCount('campaign_runs', 1);
  });

  async function expectCount(table: string, expected: number): Promise<void> {
    const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
    expect(Number(result.rows[0]!.count)).toBe(expected);
  }
});
