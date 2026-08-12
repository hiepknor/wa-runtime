import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { runtimeConfig } from '../src/core/config/runtime-config';

interface CampaignRunView {
  id: string;
  status: string;
  totalTargets: number;
  progress: {
    pending: number;
    materialized: number;
    processing: number;
    dryRunCompleted: number;
    failed: number;
    unknown: number;
  };
}

interface LoadResult {
  event: 'load_test.completed';
  targetCount: number;
  durationMs: number;
  throughputPerSecond: number;
  maxBufferedMessageJobs: number;
  deliveryCount: number;
  distinctMessageJobs: number;
  attemptCount: number;
  duplicateAttempts: number;
  finalStatus: string;
}

const config = runtimeConfig();
const targetCount = numberSetting('LOAD_TEST_TARGET_COUNT', 500, 1, 1000);
const timeoutMs = numberSetting('LOAD_TEST_TIMEOUT_MS', 600_000, 10_000, 3_600_000);
const pollMs = numberSetting('LOAD_TEST_POLL_MS', 500, 100, 10_000);
const apiUrl = process.env.LOAD_TEST_API_URL ?? 'http://127.0.0.1:3100/api/v1';
const sessionId = config.OPENWA_ALLOWED_SESSION_IDS[0]!;
const token = randomUUID().replaceAll('-', '').slice(0, 12);
const groupIds = Array.from({ length: targetCount }, (_, index) =>
  `load-${token}-${String(index + 1).padStart(4, '0')}@g.us`);
const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
let campaignId: string | undefined;
let runId: string | undefined;
let maxBufferedMessageJobs = 0;

async function main(): Promise<void> {
  if (config.ALLOW_LIVE_SENDS) throw new Error('Load test refused: ALLOW_LIVE_SENDS must be false');
  const startedAt = Date.now();
  try {
    await assertReadyAndSafe();
    await seedGroups();
    const campaign = await apiRequest<{ id: string }>('/campaigns', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        name: `Load test ${token}`,
        text: `Dry-run load test ${token}`,
        scheduleType: 'IMMEDIATE',
      }),
    });
    campaignId = campaign.id;
    await apiRequest(`/campaigns/${campaignId}/targets`, {
      method: 'PUT',
      body: JSON.stringify({ groupIds }),
    });
    const run = await apiRequest<CampaignRunView>(`/campaigns/${campaignId}/runs`, {
      method: 'POST',
      headers: { 'idempotency-key': `load-test-${token}` },
      body: JSON.stringify({ executionMode: 'DRY_RUN' }),
    });
    runId = run.id;
    const finalRun = await waitForCompletion(startedAt);
    const result = await verify(startedAt, finalRun);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await cleanup();
  }
}

async function assertReadyAndSafe(): Promise<void> {
  const response = await fetch(`${apiUrl}/health/ready`);
  if (!response.ok) throw new Error(`Runtime readiness failed with HTTP ${response.status}`);
  const health = await response.json() as { status?: string; liveSendsEnabled?: boolean };
  if (health.status !== 'ready') throw new Error('Runtime is not ready');
  if (health.liveSendsEnabled) throw new Error('Load test refused: readiness reports live sends enabled');
  const session = await pool.query('SELECT 1 FROM gateway_sessions WHERE id = $1', [sessionId]);
  if (!session.rowCount) throw new Error('Allowlisted session must be synchronized before the load test');
}

async function seedGroups(): Promise<void> {
  await pool.query(
    `INSERT INTO gateway_groups
       (session_id, id, name, is_admin, is_read_only, is_announce, is_active,
        details_synced_at, send_capability, send_capability_reason, capability_checked_at)
     SELECT $1, item.id, 'Load test ' || item.ordinality, true, false, false, true,
       now(), 'ALLOWED', 'SEND_ALLOWED', now()
     FROM unnest($2::text[]) WITH ORDINALITY AS item(id, ordinality)`,
    [sessionId, groupIds],
  );
}

async function waitForCompletion(startedAt: number): Promise<CampaignRunView> {
  let lastReported = -1;
  while (Date.now() - startedAt < timeoutMs) {
    const run = await apiRequest<CampaignRunView>(`/campaign-runs/${runId}`);
    const buffered = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM campaign_deliveries cd
       JOIN message_jobs mj ON mj.id = cd.message_job_id
       WHERE cd.run_id = $1 AND mj.status IN ('SCHEDULED','QUEUED','PROCESSING')`,
      [runId],
    );
    maxBufferedMessageJobs = Math.max(maxBufferedMessageJobs, Number(buffered.rows[0]?.count ?? 0));
    if (run.progress.dryRunCompleted !== lastReported && run.progress.dryRunCompleted % 50 === 0) {
      lastReported = run.progress.dryRunCompleted;
      process.stdout.write(`${JSON.stringify({
        event: 'load_test.progress', completed: lastReported, total: targetCount, status: run.status,
      })}\n`);
    }
    if (['COMPLETED', 'PARTIAL_FAILED', 'CANCELLED', 'FAILED'].includes(run.status)) return run;
    await delay(pollMs);
  }
  throw new Error(`Load test timed out after ${timeoutMs}ms`);
}

async function verify(startedAt: number, run: CampaignRunView): Promise<LoadResult> {
  const counts = await pool.query<{
    delivery_count: string;
    distinct_jobs: string;
    attempt_count: string;
    duplicate_attempts: string;
  }>(
    `SELECT
       count(DISTINCT cd.id)::text AS delivery_count,
       count(DISTINCT cd.message_job_id)::text AS distinct_jobs,
       count(ma.id)::text AS attempt_count,
       (count(ma.id) - count(DISTINCT ma.message_job_id))::text AS duplicate_attempts
     FROM campaign_deliveries cd
     LEFT JOIN message_jobs mj ON mj.id = cd.message_job_id
     LEFT JOIN message_attempts ma ON ma.message_job_id = mj.id
     WHERE cd.run_id = $1`,
    [runId],
  );
  const row = counts.rows[0]!;
  const durationMs = Date.now() - startedAt;
  const result: LoadResult = {
    event: 'load_test.completed',
    targetCount,
    durationMs,
    throughputPerSecond: Math.round(targetCount / (durationMs / 1000) * 100) / 100,
    maxBufferedMessageJobs,
    deliveryCount: Number(row.delivery_count),
    distinctMessageJobs: Number(row.distinct_jobs),
    attemptCount: Number(row.attempt_count),
    duplicateAttempts: Number(row.duplicate_attempts),
    finalStatus: run.status,
  };
  if (run.status !== 'COMPLETED'
    || run.totalTargets !== targetCount
    || run.progress.dryRunCompleted !== targetCount
    || run.progress.failed !== 0
    || run.progress.unknown !== 0
    || result.deliveryCount !== targetCount
    || result.distinctMessageJobs !== targetCount
    || result.attemptCount !== targetCount
    || result.duplicateAttempts !== 0
    || result.maxBufferedMessageJobs > 5) {
    throw new Error(`Load-test invariants failed: ${JSON.stringify({ run, result })}`);
  }
  return result;
}

async function cleanup(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (runId) await cleanupRun(client, runId);
    if (campaignId) await client.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
    await client.query('DELETE FROM gateway_groups WHERE session_id = $1 AND id = ANY($2::text[])', [sessionId, groupIds]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function cleanupRun(client: PoolClient, id: string): Promise<void> {
  const jobs = await client.query<{ message_job_id: string }>(
    'SELECT message_job_id FROM campaign_deliveries WHERE run_id = $1 AND message_job_id IS NOT NULL', [id],
  );
  await client.query('DELETE FROM campaign_runs WHERE id = $1', [id]);
  const ids = jobs.rows.map(row => row.message_job_id);
  if (ids.length) await client.query('DELETE FROM message_jobs WHERE id = ANY($1::uuid[])', [ids]);
}

async function apiRequest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  headers.set('x-runtime-key', config.RUNTIME_API_KEY);
  const response = await fetch(`${apiUrl}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

function numberSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
