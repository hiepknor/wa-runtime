import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DISALLOWED_SESSION_ID,
  INTEGRATION_GROUP_ID,
  INTEGRATION_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
  seedSendableGroup,
} from '../support/integration-database';

interface CampaignBody {
  id: string;
  sessionId: string;
  name: string;
  text: string;
  scheduleType: 'IMMEDIATE' | 'ONCE';
  scheduledAt: string | null;
  status: string;
  targetCount: number;
  revision: number;
  targetsRevision: number;
}

describe('campaign draft contract HTTP API', () => {
  let pool: Pool;
  let app: INestApplication;
  let baseUrl: string;
  const auth = { 'x-runtime-key': process.env.RUNTIME_API_KEY! };

  beforeAll(async () => {
    pool = integrationPool();
    const { ApiAppModule } = require(resolve(process.cwd(), 'dist/src/app/api-app.module.js')) as {
      ApiAppModule: new (...args: never[]) => unknown;
    };
    app = await NestFactory.create(ApiAppModule, { rawBody: true, logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await seedSendableGroup(pool);
  });

  afterAll(async () => { await app.close(); await pool.end(); });

  async function jsonRequest(path: string, init: RequestInit = {}) {
    const headers = {
      ...auth,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    };
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    return { response, body: await response.json() as Record<string, any> };
  }

  async function createCampaign(
    overrides: Record<string, unknown> = {},
    idempotencyKey: string = randomUUID(),
  ) {
    return jsonRequest('/campaigns', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({
        sessionId: INTEGRATION_SESSION_ID,
        name: 'Draft campaign',
        text: 'Hello group',
        ...overrides,
      }),
    });
  }

  it('canonicalizes scheduling and makes creation durably idempotent', async () => {
    const key = randomUUID();
    const first = await createCampaign({ scheduledAt: new Date(Date.now() + 60_000).toISOString() }, key);
    expect(first.response.status).toBe(201);
    expect(first.body).toMatchObject({ scheduleType: 'IMMEDIATE', scheduledAt: null, revision: 1, targetsRevision: 0 });

    const replay = await createCampaign({ scheduledAt: new Date(Date.now() + 120_000).toISOString() }, key);
    expect(replay.response.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);

    const count = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM campaigns');
    expect(count.rows[0]?.count).toBe('1');

    const conflict = await createCampaign({ text: 'Different payload' }, key);
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.code).toBe('CAMPAIGN_IDEMPOTENCY_CONFLICT');
  });

  it('requires a UUID idempotency key and returns typed validation errors', async () => {
    const missing = await jsonRequest('/campaigns', {
      method: 'POST',
      body: JSON.stringify({ sessionId: INTEGRATION_SESSION_ID, name: 'Draft', text: 'Hello' }),
    });
    expect(missing.response.status).toBe(400);
    expect(missing.body.code).toBe('CAMPAIGN_IDEMPOTENCY_KEY_REQUIRED');

    const invalid = await createCampaign({}, 'not-a-uuid');
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.code).toBe('CAMPAIGN_IDEMPOTENCY_KEY_INVALID');
  });

  it('validates ONCE scheduling and preserves or clears scheduling on PATCH', async () => {
    const missing = await createCampaign({ scheduleType: 'ONCE' });
    expect(missing.response.status).toBe(422);
    expect(missing.body.code).toBe('CAMPAIGN_SCHEDULE_REQUIRED');

    const invalid = await createCampaign({ scheduleType: 'ONCE', scheduledAt: 'not-a-date' });
    expect(invalid.response.status).toBe(422);
    expect(invalid.body.code).toBe('CAMPAIGN_SCHEDULE_INVALID');

    const dateOnly = await createCampaign({ scheduleType: 'ONCE', scheduledAt: '2030-01-01' });
    expect(dateOnly.response.status).toBe(422);
    expect(dateOnly.body.code).toBe('CAMPAIGN_SCHEDULE_INVALID');

    const past = await createCampaign({ scheduleType: 'ONCE', scheduledAt: '2020-01-01T00:00:00.000Z' });
    expect(past.response.status).toBe(422);
    expect(past.body.code).toBe('CAMPAIGN_SCHEDULE_IN_PAST');

    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    const created = await createCampaign({ scheduleType: 'ONCE', scheduledAt });
    const id = created.body.id as string;
    expect(created.body.scheduledAt).toBe(scheduledAt);

    const contentOnly = await jsonRequest(`/campaigns/${id}`, {
      method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(contentOnly.body).toMatchObject({ name: 'Renamed', scheduleType: 'ONCE', scheduledAt, revision: 2 });

    const immediate = await jsonRequest(`/campaigns/${id}`, {
      method: 'PATCH', body: JSON.stringify({ scheduleType: 'IMMEDIATE' }),
    });
    expect(immediate.body).toMatchObject({ scheduleType: 'IMMEDIATE', scheduledAt: null, revision: 3 });

    const onceWithoutTime = await jsonRequest(`/campaigns/${id}`, {
      method: 'PATCH', body: JSON.stringify({ scheduleType: 'ONCE' }),
    });
    expect(onceWithoutTime.response.status).toBe(422);
    expect(onceWithoutTime.body.code).toBe('CAMPAIGN_SCHEDULE_REQUIRED');

    const another = await createCampaign({ scheduleType: 'ONCE', scheduledAt });
    await pool.query("UPDATE campaigns SET scheduled_at = now() - interval '1 hour' WHERE id = $1", [another.body.id]);
    const pastScheduleContentPatch = await jsonRequest(`/campaigns/${another.body.id}`, {
      method: 'PATCH', body: JSON.stringify({ text: 'Content-only edit after due time' }),
    });
    expect(pastScheduleContentPatch.response.status).toBe(200);
    expect(pastScheduleContentPatch.body.scheduleType).toBe('ONCE');

    const touchedPast = await jsonRequest(`/campaigns/${another.body.id}`, {
      method: 'PATCH', body: JSON.stringify({ scheduledAt: '2020-01-01T00:00:00.000Z' }),
    });
    expect(touchedPast.response.status).toBe(422);
    expect(touchedPast.body.code).toBe('CAMPAIGN_SCHEDULE_IN_PAST');
  });

  it('only updates DRAFT campaigns and returns canonical UTC response dates', async () => {
    const created = await createCampaign();
    const id = created.body.id as string;
    await pool.query("UPDATE campaigns SET status = 'ACTIVE' WHERE id = $1", [id]);
    const response = await jsonRequest(`/campaigns/${id}`, {
      method: 'PATCH', body: JSON.stringify({ text: 'Changed' }),
    });
    expect(response.response.status).toBe(409);
    expect(response.body.code).toBe('CAMPAIGN_NOT_EDITABLE');
    expect(new Date(created.body.createdAt as string).toISOString()).toBe(created.body.createdAt);
  });

  it('atomically replaces targets, permits durable inactive/capability records, and returns canonical order', async () => {
    const campaign = await createCampaign();
    const id = campaign.body.id as string;
    await pool.query(
      `INSERT INTO gateway_groups
         (session_id, id, name, is_active, send_capability, send_capability_reason)
       VALUES ($1, 'denied@g.us', 'Zulu denied', false, 'DENIED', 'GROUP_READ_ONLY'),
              ($1, 'unknown@g.us', 'Alpha unknown', true, 'UNKNOWN', 'METADATA_INCOMPLETE')`,
      [INTEGRATION_SESSION_ID],
    );
    const replaced = await jsonRequest(`/campaigns/${id}/targets`, {
      method: 'PUT', body: JSON.stringify({ groupIds: ['denied@g.us', INTEGRATION_GROUP_ID, 'unknown@g.us'] }),
    });
    expect(replaced.response.status).toBe(200);
    expect(replaced.body.data.map((target: { groupName: string }) => target.groupName)).toEqual([
      'Alpha unknown', 'Integration group', 'Zulu denied',
    ]);
    expect(replaced.body.data.every((target: Record<string, unknown>) =>
      'groupId' in target && 'groupName' in target && 'enabled' in target && 'sendCapability' in target,
    )).toBe(true);

    const before = await pool.query<{ group_id: string }>(
      'SELECT group_id FROM campaign_targets WHERE campaign_id = $1 ORDER BY group_id', [id],
    );
    const invalid = await jsonRequest(`/campaigns/${id}/targets`, {
      method: 'PUT', body: JSON.stringify({ groupIds: [INTEGRATION_GROUP_ID, 'missing@g.us'] }),
    });
    expect(invalid.response.status).toBe(422);
    expect(invalid.body.code).toBe('CAMPAIGN_TARGET_NOT_FOUND');
    const after = await pool.query<{ group_id: string }>(
      'SELECT group_id FROM campaign_targets WHERE campaign_id = $1 ORDER BY group_id', [id],
    );
    expect(after.rows).toEqual(before.rows);

    const empty = await jsonRequest(`/campaigns/${id}/targets`, {
      method: 'PUT', body: JSON.stringify({ groupIds: [] }),
    });
    expect(empty.body.data).toEqual([]);
  });

  it('rejects duplicate, over-limit, wrong-session, missing, and non-DRAFT replacements', async () => {
    const campaign = await createCampaign();
    const id = campaign.body.id as string;
    const duplicate = await jsonRequest(`/campaigns/${id}/targets`, {
      method: 'PUT', body: JSON.stringify({ groupIds: [INTEGRATION_GROUP_ID, INTEGRATION_GROUP_ID] }),
    });
    expect(duplicate.body.code).toBe('CAMPAIGN_TARGET_DUPLICATE');

    const tooMany = Array.from({ length: 1001 }, (_, index) => `bulk-${index}@g.us`);
    const overLimit = await jsonRequest(`/campaigns/${id}/targets`, {
      method: 'PUT', body: JSON.stringify({ groupIds: tooMany }),
    });
    expect(overLimit.body.code).toBe('CAMPAIGN_TARGET_LIMIT_EXCEEDED');

    await pool.query(
      `INSERT INTO gateway_sessions
         (id, name, status, engine_loaded, gateway_created_at, gateway_updated_at)
       VALUES ($1, 'Other session', 'ready', true, now(), now())`, [DISALLOWED_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO gateway_groups (session_id, id, name, send_capability, send_capability_reason)
       VALUES ($1, 'other@g.us', 'Other', 'ALLOWED', 'SEND_ALLOWED')`, [DISALLOWED_SESSION_ID],
    );
    const wrongSession = await jsonRequest(`/campaigns/${id}/targets`, {
      method: 'PUT', body: JSON.stringify({ groupIds: ['other@g.us'] }),
    });
    expect(wrongSession.body.code).toBe('CAMPAIGN_TARGET_SESSION_MISMATCH');

    await pool.query("UPDATE campaigns SET status = 'ACTIVE' WHERE id = $1", [id]);
    const notDraft = await jsonRequest(`/campaigns/${id}/targets`, {
      method: 'PUT', body: JSON.stringify({ groupIds: [] }),
    });
    expect(notDraft.response.status).toBe(409);
    expect(notDraft.body.code).toBe('CAMPAIGN_NOT_EDITABLE');
  });

  it('accepts exactly 1000 unique targets and advances targetsRevision without changing content revision', async () => {
    const campaign = await createCampaign();
    const id = campaign.body.id as string;
    await pool.query(
      `INSERT INTO gateway_groups (session_id, id, name, send_capability, send_capability_reason)
       SELECT $1, 'bulk-' || value || '@g.us', 'Bulk ' || lpad(value::text, 4, '0'), 'ALLOWED', 'SEND_ALLOWED'
       FROM generate_series(1, 1000) AS value`, [INTEGRATION_SESSION_ID],
    );
    const ids = Array.from({ length: 1000 }, (_, index) => `bulk-${index + 1}@g.us`);
    const response = await jsonRequest(`/campaigns/${id}/targets`, {
      method: 'PUT', body: JSON.stringify({ groupIds: ids }),
    });
    expect(response.response.status).toBe(200);
    expect(response.body.data).toHaveLength(1000);
    const current = await jsonRequest(`/campaigns/${id}`);
    expect(current.body).toMatchObject({ revision: 1, targetsRevision: 1, targetCount: 1000 });
  });

  it('keeps DRY_RUN and LIVE preflight side-effect-free and revision-bound', async () => {
    const campaign = await createCampaign();
    const id = campaign.body.id as string;
    await pool.query(
      `INSERT INTO gateway_groups (session_id, id, name, send_capability, send_capability_reason)
       VALUES ($1, 'denied@g.us', 'Denied', 'DENIED', 'GROUP_READ_ONLY'),
              ($1, 'unknown@g.us', 'Unknown', 'UNKNOWN', 'METADATA_INCOMPLETE')`,
      [INTEGRATION_SESSION_ID],
    );
    await jsonRequest(`/campaigns/${id}/targets`, {
      method: 'PUT', body: JSON.stringify({ groupIds: [INTEGRATION_GROUP_ID, 'denied@g.us', 'unknown@g.us'] }),
    });
    await fetch(`${process.env.OPENWA_BASE_URL}/__test/reset`, { method: 'POST' });

    const before = await pool.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM campaign_runs)::text AS runs,
         (SELECT count(*) FROM campaign_run_targets)::text AS run_targets,
         (SELECT count(*) FROM campaign_deliveries)::text AS deliveries,
         (SELECT count(*) FROM message_jobs)::text AS jobs`,
    );
    const dryRun = await jsonRequest(`/campaigns/${id}/preflight`, {
      method: 'POST', body: JSON.stringify({ executionMode: 'DRY_RUN' }),
    });
    const live = await jsonRequest(`/campaigns/${id}/preflight`, {
      method: 'POST', body: JSON.stringify({ executionMode: 'LIVE' }),
    });
    expect(dryRun.body).toMatchObject({
      status: 'WARN', policyVersion: 1, executionMode: 'DRY_RUN', campaignRevision: 1,
      targetsRevision: 1, totalTargets: 3, allowedTargets: 1, deniedTargets: 1, unknownTargets: 1,
    });
    expect(live.body.status).toBe('BLOCK');
    for (const report of [dryRun.body, live.body]) {
      expect(report.totalTargets).toBe(report.allowedTargets + report.deniedTargets + report.unknownTargets);
      expect(report.targetIssues.map((issue: { reason: string }) => issue.reason)).toEqual([
        'TARGET_CAPABILITY_DENIED', 'TARGET_CAPABILITY_UNKNOWN',
      ]);
      expect(new Date(report.checkedAt as string).toISOString()).toBe(report.checkedAt);
    }
    const after = await pool.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM campaign_runs)::text AS runs,
         (SELECT count(*) FROM campaign_run_targets)::text AS run_targets,
         (SELECT count(*) FROM campaign_deliveries)::text AS deliveries,
         (SELECT count(*) FROM message_jobs)::text AS jobs`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    const sendStats = await fetch(`${process.env.OPENWA_BASE_URL}/__test/stats`).then(response => response.json()) as {
      sendCalls: number;
    };
    expect(sendStats.sendCalls).toBe(0);
  });
});
