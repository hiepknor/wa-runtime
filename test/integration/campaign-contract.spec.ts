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
  let runPreparer: { prepare(runId: string): Promise<void> };
  let runRepository: {
    getPreflightContext(runId: string): Promise<Record<string, any> | null>;
    resume(runId: string, report: Record<string, any>, targets: Record<string, any>[]): Promise<unknown>;
    claimPreparation(runId: string): Promise<{ leaseToken: string } | null>;
    applyPreflight(
      runId: string,
      leaseToken: string,
      report: Record<string, any>,
      targets: Record<string, any>[],
    ): Promise<unknown>;
    auditLifecycle(): Promise<Record<string, number>>;
  };
  const auth = { 'x-runtime-key': process.env.RUNTIME_API_KEY! };

  beforeAll(async () => {
    pool = integrationPool();
    const { ApiAppModule } = require(resolve(process.cwd(), 'dist/src/app/api-app.module.js')) as {
      ApiAppModule: new (...args: never[]) => unknown;
    };
    const { CampaignRunService } = require(
      resolve(process.cwd(), 'dist/src/modules/campaigns/campaign-run.service.js'),
    ) as { CampaignRunService: new (...args: never[]) => { prepare(runId: string): Promise<void> } };
    const { CampaignRunRepository } = require(
      resolve(process.cwd(), 'dist/src/modules/campaigns/campaign-run.repository.js'),
    ) as { CampaignRunRepository: new (...args: never[]) => typeof runRepository };
    app = await NestFactory.create(ApiAppModule, { rawBody: true, logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    runPreparer = app.get(CampaignRunService);
    runRepository = app.get(CampaignRunRepository);
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
    return {
      response,
      body: response.status === 204 ? {} : await response.json() as Record<string, any>,
    };
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

  it('serializes concurrent campaign creation retries', async () => {
    const key = randomUUID();
    const [left, right] = await Promise.all([
      createCampaign({}, key),
      createCampaign({}, key),
    ]);
    expect([left.response.status, right.response.status].sort()).toEqual([200, 201]);
    expect(left.body.id).toBe(right.body.id);
    const count = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM campaigns');
    expect(count.rows[0]?.count).toBe('1');
  });

  it('soft-deletes a quiescent draft with revision fences and retires its create key', async () => {
    const key = randomUUID();
    const created = await createCampaign({}, key);
    const campaignId = created.body.id as string;
    await jsonRequest(`/campaigns/${campaignId}/targets`, {
      method: 'PUT', body: JSON.stringify({ groupIds: [INTEGRATION_GROUP_ID] }),
    });

    const stale = await jsonRequest(
      `/campaigns/${campaignId}?expectedRevision=2&expectedTargetsRevision=1`,
      { method: 'DELETE' },
    );
    expect(stale.response.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'CAMPAIGN_REVISION_CONFLICT',
      details: { currentRevision: 1, currentTargetsRevision: 1 },
    });

    const deleted = await jsonRequest(
      `/campaigns/${campaignId}?expectedRevision=1&expectedTargetsRevision=1`,
      { method: 'DELETE' },
    );
    expect(deleted.response.status).toBe(204);
    const repeated = await jsonRequest(
      `/campaigns/${campaignId}?expectedRevision=1&expectedTargetsRevision=1`,
      { method: 'DELETE' },
    );
    expect(repeated.response.status).toBe(204);

    const hidden = await jsonRequest(`/campaigns/${campaignId}`);
    expect(hidden.response.status).toBe(404);
    expect(hidden.body.code).toBe('CAMPAIGN_NOT_FOUND');
    const list = await jsonRequest(`/campaigns?sessionId=${INTEGRATION_SESSION_ID}`);
    expect(list.body.data).toEqual([]);
    const edit = await jsonRequest(`/campaigns/${campaignId}`, {
      method: 'PATCH', body: JSON.stringify({ name: 'Must stay deleted' }),
    });
    expect(edit.response.status).toBe(404);
    const targets = await jsonRequest(`/campaigns/${campaignId}/targets`);
    expect(targets.response.status).toBe(404);
    const replaceTargets = await jsonRequest(`/campaigns/${campaignId}/targets`, {
      method: 'PUT', body: JSON.stringify({ expectedTargetsRevision: 1, groupIds: [] }),
    });
    expect(replaceTargets.response.status).toBe(404);
    const applySource = await jsonRequest(`/campaigns/${campaignId}/targets/apply-group-list`, {
      method: 'POST', body: JSON.stringify({ groupListId: randomUUID(), expectedTargetsRevision: 1 }),
    });
    expect(applySource.response.status).toBe(404);
    const preflight = await jsonRequest(`/campaigns/${campaignId}/preflight`, {
      method: 'POST', body: JSON.stringify({ executionMode: 'DRY_RUN' }),
    });
    expect(preflight.response.status).toBe(404);
    const launch = await jsonRequest(`/campaigns/${campaignId}/runs`, {
      method: 'POST', headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ executionMode: 'DRY_RUN' }),
    });
    expect(launch.response.status).toBe(404);

    const retained = await pool.query<{
      deleted_at: Date | null; revision: string; targets: string;
    }>(
      `SELECT c.deleted_at, c.revision::text,
         (SELECT count(*)::text FROM campaign_targets ct WHERE ct.campaign_id = c.id) AS targets
       FROM campaigns c WHERE c.id = $1`,
      [campaignId],
    );
    expect(retained.rows[0]?.deleted_at).toBeInstanceOf(Date);
    expect(retained.rows[0]).toMatchObject({ revision: '2', targets: '1' });
    await expect(pool.query("UPDATE campaigns SET status = 'ACTIVE' WHERE id = $1", [campaignId]))
      .rejects.toMatchObject({ constraint: 'campaigns_deleted_state_check' });

    const retiredReplay = await createCampaign({}, key);
    expect(retiredReplay.response.status).toBe(409);
    expect(retiredReplay.body.code).toBe('CAMPAIGN_IDEMPOTENCY_KEY_RETIRED');
  });

  it('requires every non-terminal dry-run to be cancelled but retains terminal run audit', async () => {
    const created = await createCampaign();
    const campaignId = created.body.id as string;
    const run = await jsonRequest(`/campaigns/${campaignId}/runs`, {
      method: 'POST', headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ executionMode: 'DRY_RUN' }),
    });
    const runId = run.body.id as string;

    const blocked = await jsonRequest(
      `/campaigns/${campaignId}?expectedRevision=1&expectedTargetsRevision=0`,
      { method: 'DELETE' },
    );
    expect(blocked.response.status).toBe(409);
    expect(blocked.body.code).toBe('CAMPAIGN_DELETE_RUN_CONFLICT');

    expect((await jsonRequest(`/campaign-runs/${runId}/cancel`, { method: 'POST' })).response.status).toBe(201);
    expect((await jsonRequest(
      `/campaigns/${campaignId}?expectedRevision=1&expectedTargetsRevision=0`,
      { method: 'DELETE' },
    )).response.status).toBe(204);
    expect((await jsonRequest(`/campaign-runs/${runId}`)).response.status).toBe(200);
    expect((await jsonRequest(`/campaigns/${campaignId}/runs`)).response.status).toBe(404);
    const count = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM campaign_runs WHERE campaign_id = $1',
      [campaignId],
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('requires an ACTIVE campaign to cancel its LIVE run before deletion', async () => {
    const created = await createCampaign();
    const campaignId = created.body.id as string;
    const run = await jsonRequest(`/campaigns/${campaignId}/runs`, {
      method: 'POST', headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ executionMode: 'LIVE' }),
    });
    const activeDelete = await jsonRequest(
      `/campaigns/${campaignId}?expectedRevision=1&expectedTargetsRevision=0`,
      { method: 'DELETE' },
    );
    expect(activeDelete.response.status).toBe(409);
    expect(activeDelete.body).toMatchObject({
      code: 'CAMPAIGN_DELETE_STATE_CONFLICT', details: { currentStatus: 'ACTIVE' },
    });

    await jsonRequest(`/campaign-runs/${run.body.id as string}/cancel`, { method: 'POST' });
    expect((await jsonRequest(`/campaigns/${campaignId}`)).body.status).toBe('ARCHIVED');
    expect((await jsonRequest(
      `/campaigns/${campaignId}?expectedRevision=1&expectedTargetsRevision=0`,
      { method: 'DELETE' },
    )).response.status).toBe(204);
  });

  it('serializes deletion against LIVE launch so exactly one state transition wins', async () => {
    const created = await createCampaign();
    const campaignId = created.body.id as string;
    const [deletion, launch] = await Promise.all([
      jsonRequest(`/campaigns/${campaignId}?expectedRevision=1&expectedTargetsRevision=0`, {
        method: 'DELETE',
      }),
      jsonRequest(`/campaigns/${campaignId}/runs`, {
        method: 'POST', headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ executionMode: 'LIVE' }),
      }),
    ]);
    expect([
      [204, 404],
      [409, 201],
    ]).toContainEqual([deletion.response.status, launch.response.status]);
    const state = await pool.query<{ deleted: boolean; status: string; runs: string }>(
      `SELECT c.deleted_at IS NOT NULL AS deleted, c.status::text,
         (SELECT count(*)::text FROM campaign_runs cr WHERE cr.campaign_id = c.id) AS runs
       FROM campaigns c WHERE c.id = $1`,
      [campaignId],
    );
    if (deletion.response.status === 204) {
      expect(state.rows[0]).toEqual({ deleted: true, status: 'DRAFT', runs: '0' });
    } else {
      expect(state.rows[0]).toEqual({ deleted: false, status: 'ACTIVE', runs: '1' });
    }
  });

  it('serializes deletion against target replacement without a partial audience write', async () => {
    const created = await createCampaign();
    const campaignId = created.body.id as string;
    const [deletion, replacement] = await Promise.all([
      jsonRequest(`/campaigns/${campaignId}?expectedRevision=1&expectedTargetsRevision=0`, {
        method: 'DELETE',
      }),
      jsonRequest(`/campaigns/${campaignId}/targets`, {
        method: 'PUT',
        body: JSON.stringify({ expectedTargetsRevision: 0, groupIds: [INTEGRATION_GROUP_ID] }),
      }),
    ]);
    expect([
      [204, 404],
      [409, 200],
    ]).toContainEqual([deletion.response.status, replacement.response.status]);
    const state = await pool.query<{ deleted: boolean; targets_revision: string; targets: string }>(
      `SELECT c.deleted_at IS NOT NULL AS deleted, c.targets_revision::text,
         (SELECT count(*)::text FROM campaign_targets ct WHERE ct.campaign_id = c.id) AS targets
       FROM campaigns c WHERE c.id = $1`,
      [campaignId],
    );
    if (deletion.response.status === 204) {
      expect(state.rows[0]).toEqual({ deleted: true, targets_revision: '0', targets: '0' });
    } else {
      expect(state.rows[0]).toEqual({ deleted: false, targets_revision: '1', targets: '1' });
    }
  });

  it('validates deletion preconditions and preserves not-found session scoping', async () => {
    const created = await createCampaign();
    const missingPreconditions = await jsonRequest(`/campaigns/${created.body.id as string}`, {
      method: 'DELETE',
    });
    expect(missingPreconditions.response.status).toBe(400);
    expect(missingPreconditions.body.code).toBe('CAMPAIGN_TARGETS_REVISION_INVALID');

    await pool.query(
      `INSERT INTO gateway_sessions
         (id, name, status, engine_loaded, gateway_created_at, gateway_updated_at)
       VALUES ($1, 'Hidden session', 'ready', true, now(), now())`,
      [DISALLOWED_SESSION_ID],
    );
    const hidden = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (session_id, name, payload)
       VALUES ($1, 'Hidden campaign', '{"text":"hidden"}'::jsonb) RETURNING id`,
      [DISALLOWED_SESSION_ID],
    );
    const denied = await jsonRequest(
      `/campaigns/${hidden.rows[0]!.id}?expectedRevision=1&expectedTargetsRevision=0`,
      { method: 'DELETE' },
    );
    expect(denied.response.status).toBe(404);
    expect(denied.body.code).toBe('CAMPAIGN_NOT_FOUND');
    const retained = await pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM campaigns WHERE id = $1',
      [hidden.rows[0]!.id],
    );
    expect(retained.rows[0]?.deleted_at).toBeNull();
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

  it('rejects stale campaign and target revisions without overwriting newer state', async () => {
    const created = await createCampaign();
    const id = created.body.id as string;
    const updated = await jsonRequest(`/campaigns/${id}`, {
      method: 'PATCH', body: JSON.stringify({ expectedRevision: 1, name: 'Current name' }),
    });
    expect(updated.body).toMatchObject({ name: 'Current name', revision: 2 });

    const staleContent = await jsonRequest(`/campaigns/${id}`, {
      method: 'PATCH', body: JSON.stringify({ expectedRevision: 1, text: 'Stale overwrite' }),
    });
    expect(staleContent.response.status).toBe(409);
    expect(staleContent.body.code).toBe('CAMPAIGN_REVISION_CONFLICT');
    expect((await jsonRequest(`/campaigns/${id}`)).body).toMatchObject({
      name: 'Current name', text: 'Hello group', revision: 2,
    });

    const targets = await jsonRequest(`/campaigns/${id}/targets`, {
      method: 'PUT',
      body: JSON.stringify({ expectedTargetsRevision: 0, groupIds: [INTEGRATION_GROUP_ID] }),
    });
    expect(targets.response.status).toBe(200);
    expect(targets.body.targetsRevision).toBe(1);
    const staleTargets = await jsonRequest(`/campaigns/${id}/targets`, {
      method: 'PUT', body: JSON.stringify({ expectedTargetsRevision: 0, groupIds: [] }),
    });
    expect(staleTargets.response.status).toBe(409);
    expect(staleTargets.body.code).toBe('CAMPAIGN_TARGETS_REVISION_CONFLICT');
    expect((await jsonRequest(`/campaigns/${id}/targets`)).body).toMatchObject({
      targetsRevision: 1, data: [expect.objectContaining({ groupId: INTEGRATION_GROUP_ID })],
    });
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

  it('atomically applies one saved-list membership revision and preserves auditable snapshot provenance', async () => {
    await pool.query(
      `INSERT INTO gateway_groups (session_id, id, name, send_capability, send_capability_reason)
       VALUES ($1, 'second@g.us', 'Second group', 'ALLOWED', 'SEND_ALLOWED')`,
      [INTEGRATION_SESSION_ID],
    );
    const list = await jsonRequest('/group-lists', {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        sessionId: INTEGRATION_SESSION_ID,
        name: 'Reusable audience',
        groupIds: [INTEGRATION_GROUP_ID, 'second@g.us'],
      }),
    });
    const campaign = await createCampaign();
    const campaignId = campaign.body.id as string;
    const applied = await jsonRequest(`/campaigns/${campaignId}/targets/apply-group-list`, {
      method: 'POST',
      body: JSON.stringify({
        groupListId: list.body.id,
        expectedMembershipRevision: 1,
        expectedTargetsRevision: 0,
      }),
    });
    expect(applied.response.status).toBe(200);
    expect(applied.body).toMatchObject({
      targetsRevision: 1,
      source: {
        type: 'GROUP_LIST', groupListId: list.body.id,
        groupListNameSnapshot: 'Reusable audience', membershipRevision: 1,
      },
    });
    expect(applied.body.data).toHaveLength(2);

    const editedList = await jsonRequest(`/group-lists/${list.body.id}/groups`, {
      method: 'PUT',
      body: JSON.stringify({ expectedMembershipRevision: 1, groupIds: ['second@g.us'] }),
    });
    expect(editedList.body.list.membershipRevision).toBe(2);
    const unchangedCampaign = await jsonRequest(`/campaigns/${campaignId}/targets`);
    expect(unchangedCampaign.body).toMatchObject({
      targetsRevision: 1,
      source: { groupListId: list.body.id, membershipRevision: 1 },
    });
    expect(unchangedCampaign.body.data).toHaveLength(2);

    const stale = await jsonRequest(`/campaigns/${campaignId}/targets/apply-group-list`, {
      method: 'POST',
      body: JSON.stringify({
        groupListId: list.body.id,
        expectedMembershipRevision: 1,
        expectedTargetsRevision: 1,
      }),
    });
    expect(stale.response.status).toBe(409);
    expect(stale.body.code).toBe('CAMPAIGN_TARGET_SOURCE_REVISION_CONFLICT');

    const refreshed = await jsonRequest(`/campaigns/${campaignId}/targets/apply-group-list`, {
      method: 'POST',
      body: JSON.stringify({
        groupListId: list.body.id,
        expectedMembershipRevision: 2,
        expectedTargetsRevision: 1,
      }),
    });
    expect(refreshed.body).toMatchObject({
      targetsRevision: 2,
      source: { groupListId: list.body.id, membershipRevision: 2 },
    });
    expect(refreshed.body.data).toHaveLength(1);

    const run = await jsonRequest(`/campaigns/${campaignId}/runs`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        executionMode: 'DRY_RUN', expectedCampaignRevision: 1, expectedTargetsRevision: 2,
      }),
    });
    expect(run.body.targetSource).toMatchObject({ groupListId: list.body.id, membershipRevision: 2 });

    const renamed = await jsonRequest(`/group-lists/${list.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedRevision: 2, name: 'Renamed audience' }),
    });
    expect(renamed.body.name).toBe('Renamed audience');
    expect((await jsonRequest(`/campaigns/${campaignId}/targets`)).body.source)
      .toMatchObject({ groupListNameSnapshot: 'Reusable audience', membershipRevision: 2 });
    const archiveResponse = await fetch(
      `${baseUrl}/group-lists/${list.body.id as string}?expectedRevision=3`,
      { method: 'DELETE', headers: auth },
    );
    expect(archiveResponse.status).toBe(204);
    expect((await jsonRequest(`/campaigns/${campaignId}/runs`)).body.data[0].targetSource)
      .toMatchObject({ groupListNameSnapshot: 'Reusable audience', membershipRevision: 2 });

    const manual = await jsonRequest(`/campaigns/${campaignId}/targets`, {
      method: 'PUT',
      body: JSON.stringify({ expectedTargetsRevision: 2, groupIds: ['second@g.us'] }),
    });
    expect(manual.body).toMatchObject({ targetsRevision: 3, source: null });
  });

  it('rejects every new run when legacy data already contains a LIVE launch', async () => {
    const campaign = await createCampaign();
    const campaignId = campaign.body.id as string;
    await pool.query(
      `INSERT INTO campaign_runs
         (campaign_id, session_id, idempotency_key, execution_mode, payload_snapshot, scheduled_at)
       VALUES ($1, $2, 'legacy-live', 'LIVE', '{"text":"hello"}', now())`,
      [campaignId, INTEGRATION_SESSION_ID],
    );

    for (const executionMode of ['LIVE', 'DRY_RUN']) {
      const result = await jsonRequest(`/campaigns/${campaignId}/runs`, {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ executionMode }),
      });
      expect(result.response.status).toBe(409);
      expect(result.body.code).toBe('CAMPAIGN_RUN_LAUNCH_CONFLICT');
    }
    const count = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM campaign_runs WHERE campaign_id = $1', [campaignId],
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('rejects archived and cross-session saved-list sources without changing campaign targets', async () => {
    const campaign = await createCampaign();
    const campaignId = campaign.body.id as string;
    const archived = await jsonRequest('/group-lists', {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ sessionId: INTEGRATION_SESSION_ID, name: 'Archived source' }),
    });
    const archiveResponse = await fetch(
      `${baseUrl}/group-lists/${archived.body.id as string}?expectedRevision=1`,
      { method: 'DELETE', headers: auth },
    );
    expect(archiveResponse.status).toBe(204);
    const archivedApply = await jsonRequest(`/campaigns/${campaignId}/targets/apply-group-list`, {
      method: 'POST', body: JSON.stringify({ groupListId: archived.body.id }),
    });
    expect(archivedApply.response.status).toBe(404);
    expect(archivedApply.body.code).toBe('CAMPAIGN_TARGET_SOURCE_NOT_FOUND');

    await pool.query(
      `INSERT INTO gateway_sessions
         (id, name, status, engine_loaded, gateway_created_at, gateway_updated_at)
       VALUES ($1, 'Other', 'ready', true, now(), now())`,
      [DISALLOWED_SESSION_ID],
    );
    const otherListId = randomUUID();
    await pool.query(
      `INSERT INTO group_lists (id, session_id, name) VALUES ($1, $2, 'Other source')`,
      [otherListId, DISALLOWED_SESSION_ID],
    );
    const wrongSession = await jsonRequest(`/campaigns/${campaignId}/targets/apply-group-list`, {
      method: 'POST', body: JSON.stringify({ groupListId: otherListId }),
    });
    expect(wrongSession.response.status).toBe(404);
    expect(wrongSession.body.code).toBe('CAMPAIGN_TARGET_SOURCE_NOT_FOUND');
    expect((await jsonRequest(`/campaigns/${campaignId}/targets`)).body)
      .toMatchObject({ targetsRevision: 0, source: null, data: [] });
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
    expect(dryRun.response.status).toBe(200);
    expect(live.response.status).toBe(200);
    expect(dryRun.body).toMatchObject({
      status: 'WARN', policyVersion: 2, executionMode: 'DRY_RUN', campaignRevision: 1,
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

  it('returns typed run-create validation and lists runs from one stable deterministic snapshot', async () => {
    const campaign = await createCampaign();
    const campaignId = campaign.body.id as string;
    const missingKey = await jsonRequest(`/campaigns/${campaignId}/runs`, {
      method: 'POST', body: JSON.stringify({ executionMode: 'DRY_RUN' }),
    });
    expect(missingKey.response.status).toBe(400);
    expect(missingKey.body.code).toBe('CAMPAIGN_RUN_IDEMPOTENCY_KEY_REQUIRED');

    const runIds = [
      '20000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000003',
    ];
    await pool.query(
      `INSERT INTO campaign_runs
         (id, campaign_id, session_id, idempotency_key, execution_mode, payload_snapshot, scheduled_at,
          created_at, updated_at)
       SELECT id, $1, $2, 'run-' || ordinal, 'DRY_RUN', '{"text":"hello"}'::jsonb, now(),
         '2030-01-01T00:00:00Z'::timestamptz, '2030-01-01T00:00:00Z'::timestamptz
       FROM unnest($3::uuid[]) WITH ORDINALITY AS input(id, ordinal)`,
      [campaignId, INTEGRATION_SESSION_ID, runIds],
    );

    const first = await jsonRequest(`/campaigns/${campaignId}/runs?limit=2&offset=0`);
    const second = await jsonRequest(`/campaigns/${campaignId}/runs?limit=2&offset=2`);
    expect(first.body.meta).toEqual({ total: 3, limit: 2, offset: 0 });
    expect(second.body.meta).toEqual({ total: 3, limit: 2, offset: 2 });
    expect([...first.body.data, ...second.body.data].map((run: { id: string }) => run.id)).toEqual(runIds);
  });

  it('permits many DRAFT dry-runs but atomically allows only one revision-bound LIVE launch', async () => {
    const campaign = await createCampaign();
    const campaignId = campaign.body.id as string;
    await jsonRequest(`/campaigns/${campaignId}/targets`, {
      method: 'PUT', body: JSON.stringify({ groupIds: [INTEGRATION_GROUP_ID] }),
    });
    for (let index = 0; index < 2; index += 1) {
      const dryRun = await jsonRequest(`/campaigns/${campaignId}/runs`, {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({
          executionMode: 'DRY_RUN', expectedCampaignRevision: 1, expectedTargetsRevision: 1,
        }),
      });
      expect(dryRun.response.status).toBe(201);
    }
    expect((await jsonRequest(`/campaigns/${campaignId}`)).body.status).toBe('DRAFT');

    const keys = [randomUUID(), randomUUID()];
    const launches = await Promise.all(keys.map(key => jsonRequest(`/campaigns/${campaignId}/runs`, {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: JSON.stringify({
        executionMode: 'LIVE', expectedCampaignRevision: 1, expectedTargetsRevision: 1,
      }),
    })));
    expect(launches.map(result => result.response.status).sort()).toEqual([201, 409]);
    expect(launches.find(result => result.response.status === 409)?.body.code)
      .toBe('CAMPAIGN_RUN_LAUNCH_CONFLICT');
    const winnerIndex = launches.findIndex(result => result.response.status === 201);
    const winner = launches[winnerIndex]!;
    expect((await jsonRequest(`/campaigns/${campaignId}`)).body.status).toBe('ACTIVE');

    const replay = await jsonRequest(`/campaigns/${campaignId}/runs`, {
      method: 'POST',
      headers: { 'idempotency-key': keys[winnerIndex]! },
      body: JSON.stringify({ executionMode: 'LIVE' }),
    });
    expect(replay.response.status).toBe(200);
    expect(replay.body.id).toBe(winner.body.id);

    await runPreparer.prepare(winner.body.id as string);
    expect((await jsonRequest(`/campaign-runs/${winner.body.id as string}`)).body.status).toBe('RUNNING');
    await jsonRequest(`/campaign-runs/${winner.body.id as string}/pause`, { method: 'POST' });
    expect((await jsonRequest(`/campaigns/${campaignId}`)).body.status).toBe('PAUSED');
    await jsonRequest(`/campaign-runs/${winner.body.id as string}/resume`, { method: 'POST' });
    expect((await jsonRequest(`/campaigns/${campaignId}`)).body.status).toBe('ACTIVE');
    const cancelled = await jsonRequest(`/campaign-runs/${winner.body.id as string}/cancel`, { method: 'POST' });
    expect(cancelled.body.status).toBe('CANCELLED');
    expect((await jsonRequest(`/campaigns/${campaignId}`)).body.status).toBe('ARCHIVED');
    const edit = await jsonRequest(`/campaigns/${campaignId}`, {
      method: 'PATCH', body: JSON.stringify({ name: 'Too late' }),
    });
    expect(edit.body.code).toBe('CAMPAIGN_NOT_EDITABLE');
  });

  it('rejects a LIVE launch after an ONCE schedule has expired', async () => {
    const campaign = await createCampaign({
      scheduleType: 'ONCE', scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await pool.query(
      `UPDATE campaigns SET scheduled_at = now() - interval '1 minute' WHERE id = $1`,
      [campaign.body.id],
    );
    const launch = await jsonRequest(`/campaigns/${campaign.body.id as string}/runs`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ executionMode: 'LIVE' }),
    });
    expect(launch.response.status).toBe(409);
    expect(launch.body.code).toBe('CAMPAIGN_RUN_SCHEDULE_EXPIRED');
  });

  it('keeps a campaign PAUSED when resume preflight remains blocked', async () => {
    const campaign = await createCampaign();
    const campaignId = campaign.body.id as string;
    await jsonRequest(`/campaigns/${campaignId}/targets`, {
      method: 'PUT', body: JSON.stringify({ groupIds: [INTEGRATION_GROUP_ID] }),
    });
    const run = await jsonRequest(`/campaigns/${campaignId}/runs`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ executionMode: 'LIVE' }),
    });
    await runPreparer.prepare(run.body.id as string);
    await jsonRequest(`/campaign-runs/${run.body.id as string}/pause`, { method: 'POST' });
    await pool.query(
      `UPDATE gateway_groups SET send_capability = 'DENIED',
         send_capability_reason = 'GROUP_READ_ONLY', capability_revision = capability_revision + 1
       WHERE session_id = $1 AND id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );

    const resume = await jsonRequest(`/campaign-runs/${run.body.id as string}/resume`, { method: 'POST' });
    expect(resume.response.status).toBe(409);
    expect((await jsonRequest(`/campaign-runs/${run.body.id as string}`)).body.status).toBe('BLOCKED');
    expect((await jsonRequest(`/campaigns/${campaignId}`)).body.status).toBe('PAUSED');
  });

  it('does not resume from a capability snapshot that changed during preflight', async () => {
    const campaign = await createCampaign();
    const campaignId = campaign.body.id as string;
    await jsonRequest(`/campaigns/${campaignId}/targets`, {
      method: 'PUT', body: JSON.stringify({ groupIds: [INTEGRATION_GROUP_ID] }),
    });
    const run = await jsonRequest(`/campaigns/${campaignId}/runs`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ executionMode: 'LIVE' }),
    });
    const runId = run.body.id as string;
    await runPreparer.prepare(runId);
    await jsonRequest(`/campaign-runs/${runId}/pause`, { method: 'POST' });
    const observed = await runRepository.getPreflightContext(runId);
    expect(observed?.run.preflight.status).toBe('PASS');
    await pool.query(
      `UPDATE gateway_groups SET capability_revision = capability_revision + 1
       WHERE session_id = $1 AND id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );

    expect(await runRepository.resume(runId, observed!.run.preflight, observed!.targets))
      .toBe('STALE_INPUT');
    expect((await jsonRequest(`/campaign-runs/${runId}`)).body.status).toBe('PAUSED');
    expect((await jsonRequest(`/campaigns/${campaignId}`)).body.status).toBe('PAUSED');
  });

  it('retries stale preparation input without consuming the failure-attempt budget', async () => {
    const campaign = await createCampaign();
    const campaignId = campaign.body.id as string;
    await jsonRequest(`/campaigns/${campaignId}/targets`, {
      method: 'PUT', body: JSON.stringify({ groupIds: [INTEGRATION_GROUP_ID] }),
    });
    const run = await jsonRequest(`/campaigns/${campaignId}/runs`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ executionMode: 'DRY_RUN' }),
    });
    const runId = run.body.id as string;
    const claim = await runRepository.claimPreparation(runId);
    const observed = await runRepository.getPreflightContext(runId);
    await pool.query(
      `UPDATE gateway_groups SET capability_revision = capability_revision + 1
       WHERE session_id = $1 AND id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );

    expect(await runRepository.applyPreflight(runId, claim!.leaseToken, {}, observed!.targets))
      .toBe('STALE_INPUT');
    const attempt = await pool.query<{ preparation_attempt_count: number; preparation_lease_token: string | null }>(
      `SELECT preparation_attempt_count, preparation_lease_token FROM campaign_runs WHERE id = $1`,
      [runId],
    );
    expect(attempt.rows[0]).toEqual({ preparation_attempt_count: 0, preparation_lease_token: null });
    expect(await runRepository.claimPreparation(runId)).not.toBeNull();
  });

  it('reports aggregate Campaign/LIVE lifecycle drift without exposing identifiers', async () => {
    const insertCampaign = async (name: string, status: string) => {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO campaigns (session_id, name, payload, status)
         VALUES ($1, $2, '{"text":"hello"}', $3::campaign_status) RETURNING id`,
        [INTEGRATION_SESSION_ID, name, status],
      );
      return result.rows[0]!.id;
    };
    const insertLive = (campaignId: string, key: string, status: string) => pool.query(
      `INSERT INTO campaign_runs
         (campaign_id, session_id, idempotency_key, execution_mode, payload_snapshot, scheduled_at, status)
       VALUES ($1, $2, $3, 'LIVE', '{"text":"hello"}', now(), $4::campaign_run_status)`,
      [campaignId, INTEGRATION_SESSION_ID, key, status],
    );
    await insertLive(await insertCampaign('Draft drift', 'DRAFT'), 'drift-draft', 'PREPARING');
    await insertCampaign('Active drift', 'ACTIVE');
    await insertLive(await insertCampaign('Paused drift', 'PAUSED'), 'drift-paused', 'RUNNING');
    await insertLive(await insertCampaign('Archived drift', 'ARCHIVED'), 'drift-archived', 'RUNNING');

    expect(await runRepository.auditLifecycle()).toEqual({
      draftWithLive: 1,
      activeWithoutNonTerminalLive: 1,
      pausedWithoutPausedOrBlockedLive: 1,
      archivedWithNonTerminalLive: 1,
      multipleLive: 0,
    });
  });

  it('prepares, pauses, resumes, and cancels a dry-run without calling the send adapter', async () => {
    const campaign = await createCampaign();
    const campaignId = campaign.body.id as string;
    await jsonRequest(`/campaigns/${campaignId}/targets`, {
      method: 'PUT', body: JSON.stringify({ groupIds: [INTEGRATION_GROUP_ID] }),
    });
    await fetch(`${process.env.OPENWA_BASE_URL}/__test/reset`, { method: 'POST' });

    const created = await jsonRequest(`/campaigns/${campaignId}/runs`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ executionMode: 'DRY_RUN' }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body.status).toBe('PREPARING');
    const runId = created.body.id as string;

    await runPreparer.prepare(runId);
    const prepared = await jsonRequest(`/campaign-runs/${runId}`);
    expect(prepared.body).toMatchObject({ status: 'RUNNING', totalTargets: 1 });
    expect(prepared.body.preflight).toMatchObject({ status: 'PASS', executionMode: 'DRY_RUN' });
    expect((await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM campaign_deliveries WHERE run_id = $1', [runId],
    )).rows[0]?.count).toBe('1');

    const paused = await jsonRequest(`/campaign-runs/${runId}/pause`, { method: 'POST' });
    expect(paused.body.status).toBe('PAUSED');
    const resumed = await jsonRequest(`/campaign-runs/${runId}/resume`, { method: 'POST' });
    expect(resumed.body.status).toBe('RUNNING');
    const cancelled = await jsonRequest(`/campaign-runs/${runId}/cancel`, { method: 'POST' });
    expect(cancelled.body.status).toBe('CANCELLED');
    const invalidPause = await jsonRequest(`/campaign-runs/${runId}/pause`, { method: 'POST' });
    expect(invalidPause.response.status).toBe(409);
    expect(invalidPause.body.code).toBe('CAMPAIGN_RUN_STATE_CONFLICT');

    const stats = await fetch(`${process.env.OPENWA_BASE_URL}/__test/stats`).then(response => response.json()) as {
      sendCalls: number;
    };
    expect(stats.sendCalls).toBe(0);
  });
});
