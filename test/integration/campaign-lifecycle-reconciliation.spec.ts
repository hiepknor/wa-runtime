import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  applyCampaignLifecycleReconciliation,
  auditCampaignLifecycle,
  reconcileCampaignLifecycle,
} from '../../scripts/reconcile-campaign-live-status';
import {
  INTEGRATION_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
  seedSendableGroup,
} from '../support/integration-database';

describe('campaign lifecycle reconciliation', () => {
  let pool: Pool;

  beforeAll(() => { pool = integrationPool(); });
  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await seedSendableGroup(pool);
  });
  afterAll(async () => { await pool.end(); });

  it('reconciles exactly one legacy LIVE run without exposing or replacing it', async () => {
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (session_id, name, payload)
       VALUES ($1, 'Legacy lifecycle', '{"text":"hello"}') RETURNING id`,
      [INTEGRATION_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO campaign_runs
         (campaign_id, session_id, idempotency_key, execution_mode, payload_snapshot, scheduled_at, status)
       VALUES ($1, $2, 'legacy-terminal', 'LIVE', '{"text":"hello"}', now(), 'COMPLETED')`,
      [campaign.rows[0]!.id, INTEGRATION_SESSION_ID],
    );
    const client = await pool.connect();
    try {
      expect(await auditCampaignLifecycle(client)).toEqual({
        duplicateLiveCampaigns: 0, lifecycleDrift: 1,
      });
      expect(await applyCampaignLifecycleReconciliation(client)).toEqual({
        applied: true,
        updated: 1,
        before: { duplicateLiveCampaigns: 0, lifecycleDrift: 1 },
        after: { duplicateLiveCampaigns: 0, lifecycleDrift: 0 },
      });
    } finally {
      client.release();
    }
    const state = await pool.query<{ status: string }>('SELECT status FROM campaigns WHERE id = $1', [
      campaign.rows[0]!.id,
    ]);
    expect(state.rows[0]?.status).toBe('ARCHIVED');
    expect((await pool.query('SELECT 1 FROM campaign_runs WHERE campaign_id = $1', [campaign.rows[0]!.id])).rowCount)
      .toBe(1);
  });

  it('enforces one LIVE run per campaign at the database boundary', async () => {
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (session_id, name, payload)
       VALUES ($1, 'Duplicate lifecycle', '{"text":"hello"}') RETURNING id`,
      [INTEGRATION_SESSION_ID],
    );
    const insert = (key: string) => pool.query(
      `INSERT INTO campaign_runs
         (campaign_id, session_id, idempotency_key, execution_mode, payload_snapshot, scheduled_at)
       VALUES ($1, $2, $3, 'LIVE', '{"text":"hello"}', now())`,
      [campaign.rows[0]!.id, INTEGRATION_SESSION_ID, key],
    );
    await insert('first-live');
    await expect(insert('second-live')).rejects.toMatchObject({
      code: '23505', constraint: 'uq_campaign_runs_single_live_launch',
    });
    const client = await pool.connect();
    try {
      expect(await auditCampaignLifecycle(client)).toEqual({
        duplicateLiveCampaigns: 0, lifecycleDrift: 1,
      });
      expect(await applyCampaignLifecycleReconciliation(client)).toEqual({
        applied: true,
        updated: 1,
        before: { duplicateLiveCampaigns: 0, lifecycleDrift: 1 },
        after: { duplicateLiveCampaigns: 0, lifecycleDrift: 0 },
      });
    } finally {
      client.release();
    }
    expect((await pool.query(
      'SELECT 1 FROM campaign_runs WHERE campaign_id = $1', [campaign.rows[0]!.id],
    )).rowCount).toBe(1);
  });

  it('preserves both valid campaign states for a BLOCKED LIVE run', async () => {
    for (const status of ['ACTIVE', 'PAUSED']) {
      const campaign = await pool.query<{ id: string }>(
        `INSERT INTO campaigns (session_id, name, payload, status)
         VALUES ($1, $2, '{"text":"hello"}', $3::campaign_status) RETURNING id`,
        [INTEGRATION_SESSION_ID, `Blocked ${status}`, status],
      );
      await pool.query(
        `INSERT INTO campaign_runs
           (campaign_id, session_id, idempotency_key, execution_mode, payload_snapshot, scheduled_at, status)
         VALUES ($1, $2, $3, 'LIVE', '{"text":"hello"}', now(), 'BLOCKED')`,
        [campaign.rows[0]!.id, INTEGRATION_SESSION_ID, `blocked-${status.toLowerCase()}`],
      );
    }
    const client = await pool.connect();
    try {
      expect(await auditCampaignLifecycle(client)).toEqual({
        duplicateLiveCampaigns: 0, lifecycleDrift: 0,
      });
      expect(await reconcileCampaignLifecycle(client)).toBe(0);
    } finally {
      client.release();
    }
    expect((await pool.query(
      `SELECT status FROM campaigns WHERE name LIKE 'Blocked %' ORDER BY name`,
    )).rows.map(row => row.status)).toEqual(['ACTIVE', 'PAUSED']);
  });
});
