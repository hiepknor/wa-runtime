import { Pool, type PoolClient } from 'pg';
import { runtimeConfig } from '../src/core/config/runtime-config';

export interface CampaignLifecycleReconciliationAudit {
  duplicateLiveCampaigns: number;
  lifecycleDrift: number;
}

export interface CampaignLifecycleReconciliationResult {
  applied: boolean;
  updated: number;
  before: CampaignLifecycleReconciliationAudit;
  after: CampaignLifecycleReconciliationAudit;
}

export async function auditCampaignLifecycle(
  client: PoolClient,
): Promise<CampaignLifecycleReconciliationAudit> {
  const result = await client.query<{
    duplicate_live_campaigns: string;
    lifecycle_drift: string;
  }>(
    `WITH live AS (
       SELECT campaign_id, count(*) AS live_count,
         bool_or(status IN ('PREPARING','BLOCKED','SCHEDULED','RUNNING','PAUSED')) AS has_non_terminal,
         bool_or(status IN ('PAUSED','BLOCKED')) AS has_paused_or_blocked
       FROM campaign_runs WHERE execution_mode = 'LIVE' GROUP BY campaign_id
     )
     SELECT
       count(*) FILTER (WHERE coalesce(l.live_count, 0) > 1)::text AS duplicate_live_campaigns,
       count(*) FILTER (WHERE
         (c.status = 'DRAFT' AND coalesce(l.live_count, 0) > 0)
         OR (c.status = 'ACTIVE' AND NOT coalesce(l.has_non_terminal, false))
         OR (c.status = 'PAUSED' AND NOT coalesce(l.has_paused_or_blocked, false))
         OR (c.status = 'ARCHIVED' AND coalesce(l.has_non_terminal, false)))::text AS lifecycle_drift
     FROM campaigns c LEFT JOIN live l ON l.campaign_id = c.id`,
  );
  return {
    duplicateLiveCampaigns: Number(result.rows[0]!.duplicate_live_campaigns),
    lifecycleDrift: Number(result.rows[0]!.lifecycle_drift),
  };
}

export async function reconcileCampaignLifecycle(client: PoolClient): Promise<number> {
  const result = await client.query(
    `WITH single_live AS (
       SELECT campaign_id, min(status::text) AS run_status
       FROM campaign_runs WHERE execution_mode = 'LIVE'
       GROUP BY campaign_id HAVING count(*) = 1
     )
     UPDATE campaigns c SET status = CASE
       WHEN sl.run_status = 'PAUSED' THEN 'PAUSED'::campaign_status
       WHEN sl.run_status = 'BLOCKED' AND c.status IN ('ACTIVE','PAUSED') THEN c.status
       WHEN sl.run_status IN ('COMPLETED','PARTIAL_FAILED','CANCELLED','FAILED')
         THEN 'ARCHIVED'::campaign_status
       ELSE 'ACTIVE'::campaign_status
     END, updated_at = now()
     FROM single_live sl
     WHERE c.id = sl.campaign_id AND c.status::text IS DISTINCT FROM CASE
       WHEN sl.run_status = 'PAUSED' THEN 'PAUSED'
       WHEN sl.run_status = 'BLOCKED' AND c.status IN ('ACTIVE','PAUSED') THEN c.status::text
       WHEN sl.run_status IN ('COMPLETED','PARTIAL_FAILED','CANCELLED','FAILED') THEN 'ARCHIVED'
       ELSE 'ACTIVE'
     END`,
  );
  return result.rowCount ?? 0;
}

export async function applyCampaignLifecycleReconciliation(
  client: PoolClient,
): Promise<CampaignLifecycleReconciliationResult> {
  await client.query('BEGIN');
  try {
    await client.query('LOCK TABLE campaigns, campaign_runs IN SHARE ROW EXCLUSIVE MODE');
    const before = await auditCampaignLifecycle(client);
    if (before.duplicateLiveCampaigns > 0) {
      await client.query('ROLLBACK');
      return { applied: false, updated: 0, before, after: before };
    }
    const updated = await reconcileCampaignLifecycle(client);
    const after = await auditCampaignLifecycle(client);
    await client.query('COMMIT');
    return { applied: true, updated, before, after };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const pool = new Pool({ connectionString: runtimeConfig().DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    if (!apply) {
      const before = await auditCampaignLifecycle(client);
      process.stdout.write(`${JSON.stringify({ mode: 'audit', ...before })}\n`);
      if (before.duplicateLiveCampaigns > 0 || before.lifecycleDrift > 0) process.exitCode = 2;
      return;
    }
    const result = await applyCampaignLifecycleReconciliation(client);
    process.stdout.write(`${JSON.stringify({ mode: 'reconcile', ...result })}\n`);
    if (!result.applied || result.after.duplicateLiveCampaigns > 0 || result.after.lifecycleDrift > 0) {
      process.exitCode = 2;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
