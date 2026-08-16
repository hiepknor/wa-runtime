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

describe('saved group lists HTTP API', () => {
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
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...auth, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    return {
      response,
      body: response.status === 204 ? {} : await response.json() as Record<string, any>,
    };
  }

  async function createList(
    overrides: Record<string, unknown> = {},
    idempotencyKey: string = randomUUID(),
  ) {
    return jsonRequest('/group-lists', {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({
        sessionId: INTEGRATION_SESSION_ID,
        name: 'Operators',
        description: 'Reusable operational groups',
        groupIds: [INTEGRATION_GROUP_ID],
        ...overrides,
      }),
    });
  }

  async function seedOtherSessionAndGroup() {
    await pool.query(
      `INSERT INTO gateway_sessions
         (id, name, status, engine_loaded, gateway_created_at, gateway_updated_at)
       VALUES ($1, 'Other session', 'ready', true, now(), now())`,
      [DISALLOWED_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO gateway_groups
         (session_id, id, name, send_capability, send_capability_reason)
       VALUES ($1, 'other@g.us', 'Other group', 'ALLOWED', 'SEND_ALLOWED')`,
      [DISALLOWED_SESSION_ID],
    );
  }

  it('creates atomically, normalizes metadata, and replays one idempotent intent', async () => {
    const key = randomUUID();
    const first = await createList({ name: '  Operators  ', description: '  Daily list  ' }, key);
    expect(first.response.status).toBe(201);
    expect(first.body).toMatchObject({
      sessionId: INTEGRATION_SESSION_ID,
      name: 'Operators',
      description: 'Daily list',
      groupCount: 1,
      revision: 1,
      membershipRevision: 1,
      archivedAt: null,
    });

    const replay = await createList({ name: 'Operators', description: 'Daily list' }, key);
    expect(replay.response.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);

    const conflict = await createList({ name: 'Different' }, key);
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.code).toBe('GROUP_LIST_IDEMPOTENCY_CONFLICT');

    const counts = await pool.query<{ lists: string; items: string }>(
      `SELECT
         (SELECT count(*) FROM group_lists)::text AS lists,
         (SELECT count(*) FROM group_list_items)::text AS items`,
    );
    expect(counts.rows[0]).toEqual({ lists: '1', items: '1' });
  });

  it('requires a UUID idempotency key and rejects invalid initial membership without a partial list', async () => {
    const missingKey = await jsonRequest('/group-lists', {
      method: 'POST',
      body: JSON.stringify({ sessionId: INTEGRATION_SESSION_ID, name: 'No key' }),
    });
    expect(missingKey.response.status).toBe(400);
    expect(missingKey.body.code).toBe('GROUP_LIST_IDEMPOTENCY_KEY_REQUIRED');

    const invalidKey = await createList({}, 'not-a-uuid');
    expect(invalidKey.response.status).toBe(400);
    expect(invalidKey.body.code).toBe('GROUP_LIST_IDEMPOTENCY_KEY_INVALID');

    const missingGroup = await createList({ name: 'Invalid membership', groupIds: ['missing@g.us'] });
    expect(missingGroup.response.status).toBe(422);
    expect(missingGroup.body).toMatchObject({
      code: 'GROUP_LIST_GROUP_NOT_FOUND',
      details: { invalidGroupCount: 1 },
    });
    const count = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM group_lists');
    expect(count.rows[0]?.count).toBe('0');
  });

  it('serializes concurrent retries of the same create intent', async () => {
    const key = randomUUID();
    const [left, right] = await Promise.all([
      createList({ name: 'Concurrent list' }, key),
      createList({ name: 'Concurrent list' }, key),
    ]);
    expect([left.response.status, right.response.status].sort()).toEqual([200, 201]);
    expect(left.body.id).toBe(right.body.id);
    const count = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM group_lists WHERE create_idempotency_key = $1', [key],
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('searches literal text before pagination and returns filtered totals in deterministic order', async () => {
    await createList({ name: 'Release_100%', description: 'Primary' });
    await createList({ name: 'Another', description: 'release_100% secondary', groupIds: [] });
    await createList({ name: 'Unrelated', description: null, groupIds: [] });
    await pool.query("UPDATE group_lists SET updated_at = '2030-01-01T00:00:00Z'");

    const filtered = await jsonRequest(
      `/group-lists?sessionId=${INTEGRATION_SESSION_ID}&query=${encodeURIComponent(' release_100% ')}&limit=1&offset=0`,
    );
    expect(filtered.response.status).toBe(200);
    expect(filtered.body.meta).toEqual({ total: 2, limit: 1, offset: 0 });
    const second = await jsonRequest(
      `/group-lists?sessionId=${INTEGRATION_SESSION_ID}&query=${encodeURIComponent('release_100%')}&limit=1&offset=1`,
    );
    expect(second.body.meta.total).toBe(2);
    expect(second.body.data[0].id).not.toBe(filtered.body.data[0].id);

    const wildcard = await jsonRequest(
      `/group-lists?sessionId=${INTEGRATION_SESSION_ID}&query=${encodeURIComponent('%')}`,
    );
    expect(wildcard.body.meta.total).toBe(2);

    const all = await jsonRequest(`/group-lists?sessionId=${INTEGRATION_SESSION_ID}`);
    const ids = all.body.data.map((item: { id: string }) => item.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('updates metadata canonically, enforces active name uniqueness, and only increments on change', async () => {
    const created = await createList({ description: '  ' });
    expect(created.body.description).toBeNull();
    const id = created.body.id as string;

    const noChange = await jsonRequest(`/group-lists/${id}`, {
      method: 'PATCH', body: JSON.stringify({ name: ' Operators ', description: null }),
    });
    expect(noChange.body.revision).toBe(1);

    const changed = await jsonRequest(`/group-lists/${id}`, {
      method: 'PATCH', body: JSON.stringify({ name: 'Moderators', description: ' Updated ' }),
    });
    expect(changed.body).toMatchObject({ name: 'Moderators', description: 'Updated', revision: 2 });
    expect(changed.body.membershipRevision).toBe(1);

    await createList({ name: 'Operators', groupIds: [] });
    const conflict = await jsonRequest(`/group-lists/${id}`, {
      method: 'PATCH', body: JSON.stringify({ name: 'operators' }),
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.code).toBe('GROUP_LIST_NAME_CONFLICT');
    expect(conflict.body.fieldErrors.name).toBeDefined();
  });

  it('rejects stale saved-list metadata and membership revisions', async () => {
    const created = await createList({ groupIds: [] });
    const id = created.body.id as string;
    const updated = await jsonRequest(`/group-lists/${id}`, {
      method: 'PATCH', body: JSON.stringify({ expectedRevision: 1, description: 'Current' }),
    });
    expect(updated.body).toMatchObject({ description: 'Current', revision: 2 });

    const staleMetadata = await jsonRequest(`/group-lists/${id}`, {
      method: 'PATCH', body: JSON.stringify({ expectedRevision: 1, name: 'Stale' }),
    });
    expect(staleMetadata.response.status).toBe(409);
    expect(staleMetadata.body.code).toBe('GROUP_LIST_REVISION_CONFLICT');

    const replaced = await jsonRequest(`/group-lists/${id}/groups`, {
      method: 'PUT',
      body: JSON.stringify({ expectedRevision: 2, expectedMembershipRevision: 1,
        groupIds: [INTEGRATION_GROUP_ID] }),
    });
    expect(replaced.body.list.revision).toBe(3);
    expect(replaced.body.list.membershipRevision).toBe(2);
    const staleMembership = await jsonRequest(`/group-lists/${id}/groups`, {
      method: 'PUT', body: JSON.stringify({ expectedMembershipRevision: 1, groupIds: [] }),
    });
    expect(staleMembership.response.status).toBe(409);
    expect(staleMembership.body.code).toBe('GROUP_LIST_REVISION_CONFLICT');
    expect((await jsonRequest(`/group-lists/${id}/groups`)).body.data).toHaveLength(1);
  });

  it('atomically replaces complete membership and returns current group metadata in canonical order', async () => {
    await pool.query(
      `INSERT INTO gateway_groups
         (session_id, id, name, participants_count, is_active, send_capability, send_capability_reason)
       VALUES ($1, 'denied@g.us', 'Zulu denied', 50, false, 'DENIED', 'GROUP_READ_ONLY'),
              ($1, 'unknown@g.us', 'Alpha unknown', NULL, true, 'UNKNOWN', 'METADATA_INCOMPLETE')`,
      [INTEGRATION_SESSION_ID],
    );
    const created = await createList({ groupIds: [] });
    const id = created.body.id as string;
    const replaced = await jsonRequest(`/group-lists/${id}/groups`, {
      method: 'PUT',
      body: JSON.stringify({ groupIds: ['denied@g.us', INTEGRATION_GROUP_ID, 'unknown@g.us'] }),
    });
    expect(replaced.response.status).toBe(200);
    expect(replaced.body.list).toMatchObject({ groupCount: 3, revision: 2, membershipRevision: 2 });
    expect(replaced.body.data.map((group: { groupName: string }) => group.groupName)).toEqual([
      'Alpha unknown', 'Integration group', 'Zulu denied',
    ]);
    expect(replaced.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ groupId: 'denied@g.us', isActive: false, participantsCount: 50,
        sendCapability: expect.objectContaining({ status: 'DENIED' }) }),
      expect.objectContaining({ groupId: 'unknown@g.us', isActive: true, participantsCount: null,
        sendCapability: expect.objectContaining({ status: 'UNKNOWN' }) }),
    ]));

    const same = await jsonRequest(`/group-lists/${id}/groups`, {
      method: 'PUT',
      body: JSON.stringify({ groupIds: ['unknown@g.us', INTEGRATION_GROUP_ID, 'denied@g.us'] }),
    });
    expect(same.body.list.revision).toBe(2);
    expect(same.body.list.membershipRevision).toBe(2);

    const membership = await jsonRequest(`/group-lists/${id}/groups`);
    expect(membership.body.list.revision).toBe(2);
    expect(membership.body.data).toEqual(same.body.data);
  });

  it('rejects duplicate, over-limit, missing and wrong-session replacements without mutation', async () => {
    await seedOtherSessionAndGroup();
    const created = await createList();
    const id = created.body.id as string;
    const before = await pool.query<{ group_id: string }>(
      'SELECT group_id FROM group_list_items WHERE group_list_id = $1 ORDER BY group_id', [id],
    );

    const cases = [
      { ids: [INTEGRATION_GROUP_ID, INTEGRATION_GROUP_ID], code: 'GROUP_LIST_GROUP_DUPLICATE' },
      { ids: Array.from({ length: 1001 }, (_, index) => `bulk-${index}@g.us`), code: 'GROUP_LIST_GROUP_LIMIT_EXCEEDED' },
      { ids: [INTEGRATION_GROUP_ID, 'missing@g.us'], code: 'GROUP_LIST_GROUP_NOT_FOUND' },
      { ids: ['other@g.us'], code: 'GROUP_LIST_GROUP_SESSION_MISMATCH' },
    ];
    for (const testCase of cases) {
      const result = await jsonRequest(`/group-lists/${id}/groups`, {
        method: 'PUT', body: JSON.stringify({ groupIds: testCase.ids }),
      });
      expect(result.response.status).toBe(422);
      expect(result.body.code).toBe(testCase.code);
      const after = await pool.query<{ group_id: string }>(
        'SELECT group_id FROM group_list_items WHERE group_list_id = $1 ORDER BY group_id', [id],
      );
      expect(after.rows).toEqual(before.rows);
    }

    const empty = await jsonRequest(`/group-lists/${id}/groups`, {
      method: 'PUT', body: JSON.stringify({ groupIds: [] }),
    });
    expect(empty.body).toMatchObject({ list: { groupCount: 0, revision: 2 }, data: [] });
  });

  it('accepts exactly 1000 groups and keeps the complete response bounded', async () => {
    await pool.query(
      `INSERT INTO gateway_groups (session_id, id, name, send_capability, send_capability_reason)
       SELECT $1, 'bulk-' || value || '@g.us', 'Bulk ' || lpad(value::text, 4, '0'),
         'ALLOWED', 'SEND_ALLOWED'
       FROM generate_series(1, 1000) AS value`,
      [INTEGRATION_SESSION_ID],
    );
    const created = await createList({ groupIds: [] });
    const ids = Array.from({ length: 1000 }, (_, index) => `bulk-${index + 1}@g.us`);
    const replaced = await jsonRequest(`/group-lists/${created.body.id}/groups`, {
      method: 'PUT', body: JSON.stringify({ groupIds: ids }),
    });
    expect(replaced.response.status).toBe(200);
    expect(replaced.body.list.groupCount).toBe(1000);
    expect(replaced.body.data).toHaveLength(1000);
  });

  it('soft-archives a list without changing campaign targets and hides it from all active reads', async () => {
    const createKey = randomUUID();
    const created = await createList({}, createKey);
    const listId = created.body.id as string;
    const updated = await jsonRequest(`/group-lists/${listId}`, {
      method: 'PATCH', body: JSON.stringify({ expectedRevision: 1, description: 'Ready to archive' }),
    });
    const staleArchive = await jsonRequest(`/group-lists/${listId}?expectedRevision=1`, { method: 'DELETE' });
    expect(staleArchive.response.status).toBe(409);
    expect(staleArchive.body.code).toBe('GROUP_LIST_REVISION_CONFLICT');
    const campaignId = randomUUID();
    await pool.query(
      `INSERT INTO campaigns (id, session_id, name, payload)
       VALUES ($1, $2, 'Snapshot campaign', '{"text":"hello"}'::jsonb)`,
      [campaignId, INTEGRATION_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO campaign_targets (campaign_id, session_id, group_id) VALUES ($1, $2, $3)`,
      [campaignId, INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );

    const archived = await jsonRequest(
      `/group-lists/${listId}?expectedRevision=${updated.body.revision as number}`,
      { method: 'DELETE' },
    );
    expect(archived.response.status).toBe(204);
    const list = await jsonRequest(`/group-lists/${listId}`);
    const membership = await jsonRequest(`/group-lists/${listId}/groups`);
    expect(list.response.status).toBe(404);
    expect(list.body.code).toBe('GROUP_LIST_NOT_FOUND');
    expect(membership.response.status).toBe(404);

    const archivedMutation = await jsonRequest(`/group-lists/${listId}/groups`, {
      method: 'PUT', body: JSON.stringify({ groupIds: [] }),
    });
    expect(archivedMutation.response.status).toBe(409);
    expect(archivedMutation.body.code).toBe('GROUP_LIST_ARCHIVED');
    const repeatedArchive = await jsonRequest(
      `/group-lists/${listId}?expectedRevision=${updated.body.revision as number}`,
      { method: 'DELETE' },
    );
    expect(repeatedArchive.response.status).toBe(204);
    const retiredReplay = await createList({}, createKey);
    expect(retiredReplay.response.status).toBe(409);
    expect(retiredReplay.body.code).toBe('GROUP_LIST_IDEMPOTENCY_KEY_RETIRED');

    const browse = await jsonRequest(`/group-lists?sessionId=${INTEGRATION_SESSION_ID}`);
    expect(browse.body.meta.total).toBe(0);
    const targetCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM campaign_targets WHERE campaign_id = $1', [campaignId],
    );
    expect(targetCount.rows[0]?.count).toBe('1');
    const sideEffects = await pool.query<{ runs: string; deliveries: string; jobs: string }>(
      `SELECT
         (SELECT count(*) FROM campaign_runs)::text AS runs,
         (SELECT count(*) FROM campaign_deliveries)::text AS deliveries,
         (SELECT count(*) FROM message_jobs)::text AS jobs`,
    );
    expect(sideEffects.rows[0]).toEqual({ runs: '0', deliveries: '0', jobs: '0' });
    const retained = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM group_list_items WHERE group_list_id = $1', [listId],
    );
    expect(retained.rows[0]?.count).toBe('1');
  });

  it('does not expose a list owned by a non-allowlisted session', async () => {
    await seedOtherSessionAndGroup();
    const hiddenId = randomUUID();
    await pool.query(
      `INSERT INTO group_lists (id, session_id, name) VALUES ($1, $2, 'Hidden')`,
      [hiddenId, DISALLOWED_SESSION_ID],
    );
    const direct = await jsonRequest(`/group-lists/${hiddenId}`);
    expect(direct.response.status).toBe(404);
    expect(direct.body.code).toBe('GROUP_LIST_NOT_FOUND');

    const collection = await jsonRequest(`/group-lists?sessionId=${DISALLOWED_SESSION_ID}`);
    expect(collection.response.status).toBe(404);
    expect(JSON.stringify(collection.body)).not.toContain('Hidden');
  });

  it('returns typed validation for an overlong query', async () => {
    const result = await jsonRequest(
      `/group-lists?sessionId=${INTEGRATION_SESSION_ID}&query=${'x'.repeat(201)}`,
    );
    expect(result.response.status).toBe(400);
    expect(result.body.code).toBe('GROUP_LIST_QUERY_INVALID');
    expect(result.body.fieldErrors.query).toBeDefined();

    const invalidSession = await jsonRequest('/group-lists?sessionId=');
    expect(invalidSession.response.status).toBe(400);
    expect(invalidSession.body.code).toBe('GROUP_LIST_SESSION_INVALID');

    const created = await createList({ groupIds: [] });
    const invalidGroup = await jsonRequest(`/group-lists/${created.body.id}/groups`, {
      method: 'PUT', body: JSON.stringify({ groupIds: ['not a group'] }),
    });
    expect(invalidGroup.response.status).toBe(400);
    expect(invalidGroup.body.code).toBe('GROUP_LIST_GROUP_INVALID');
  });
});
