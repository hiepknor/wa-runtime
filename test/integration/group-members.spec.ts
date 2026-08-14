import 'reflect-metadata';
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
} from '../support/group-members-database';

interface MemberResponse {
  data: Array<{
    participantId: string;
    phoneNumber: string;
    displayName: string | null;
    identityType: 'LID' | 'PHONE_JID' | 'OTHER_JID' | null;
    resolvedPhoneNumber: string | null;
    displayNameSource: string | null;
    projectionRevision: number;
    isAdmin: boolean;
    isSuperAdmin: boolean;
  }>;
  meta: { total: number; limit: number; offset: number; datasetRevision: number };
}

const OTHER_GROUP_ID = '120363000000000001@g.us';

describe('group member HTTP API', () => {
  let pool: Pool;
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    pool = integrationPool();
    const { AppModule } = require(resolve(process.cwd(), 'dist/src/app.module.js')) as {
      AppModule: new (...args: never[]) => unknown;
    };
    app = await NestFactory.create(AppModule, { rawBody: true, logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await seedSendableGroup(pool);
    await pool.query(
      'UPDATE gateway_groups SET participants_count = 999 WHERE session_id = $1 AND id = $2',
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );

    const fixedMembers = [
      ['owner@c.us', '84000000001', 'Zed Owner', false, true],
      ['admin-a@c.us', '84000000002', 'Alpha Duplicate', true, false],
      ['admin-b@c.us', '84000000003', 'Alpha Duplicate', true, false],
      ['member-a@c.us', '84000000004', 'Alpha Duplicate', false, false],
      ['member-b@c.us', '84000000005', 'Alpha Duplicate', false, false],
      ['phone-match@c.us', '84987654321', null, false, false],
      ['unique-participant@c.us', '84000000007', 'Ordinary', false, false],
      ['literal-wildcard@c.us', '84000000008', '100%_match', false, false],
    ] as const;
    const generatedMembers = Array.from({ length: 52 }, (_, index) => [
      `generated-${index.toString().padStart(2, '0')}@c.us`,
      `841${index.toString().padStart(8, '0')}`,
      `Member ${index.toString().padStart(2, '0')}`,
      false,
      false,
    ] as const);

    for (const member of [...fixedMembers, ...generatedMembers]) {
      await pool.query(
        `INSERT INTO group_members
           (session_id, group_id, participant_id, phone_number, display_name, is_admin, is_super_admin)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, ...member],
      );
    }

    await seedSendableGroup(pool, DISALLOWED_SESSION_ID);
    await pool.query(
      `INSERT INTO gateway_groups
         (session_id, id, name, is_admin, is_read_only, is_announce, details_synced_at,
          send_capability, send_capability_reason, capability_checked_at)
       VALUES ($1, $2, 'Other session group', true, false, false, now(), 'ALLOWED', 'SEND_ALLOWED', now())`,
      [DISALLOWED_SESSION_ID, OTHER_GROUP_ID],
    );
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, display_name)
       VALUES ($1, $2, 'secret@c.us', '84999999999', 'Secret Member')`,
      [DISALLOWED_SESSION_ID, OTHER_GROUP_ID],
    );
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const runtimeHeaders = { 'x-runtime-key': process.env.RUNTIME_API_KEY! };

  async function get(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: runtimeHeaders });
  }

  async function members(params = ''): Promise<{ response: Response; body: MemberResponse }> {
    const response = await get(
      `/groups/${encodeURIComponent(INTEGRATION_GROUP_ID)}/members?sessionId=${INTEGRATION_SESSION_ID}${params}`,
    );
    return { response, body: await response.json() as MemberResponse };
  }

  it('returns group metadata without embedding members', async () => {
    const response = await get(`/groups/${encodeURIComponent(INTEGRATION_GROUP_ID)}?sessionId=${INTEGRATION_SESSION_ID}`);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.id).toBe(INTEGRATION_GROUP_ID);
    expect(body.participantsCount).toBe(999);
    expect(body).not.toHaveProperty('members');
  });

  it('uses default pagination and counts synchronized rows rather than participantsCount', async () => {
    const { response, body } = await members();
    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(50);
    expect(body.meta).toEqual({ total: 60, limit: 50, offset: 0, datasetRevision: 0 });
  });

  it('supports custom pagination, empty pages, and a stable walk across three pages', async () => {
    const pages = await Promise.all([0, 20, 40].map(offset => members(`&limit=20&offset=${offset}`)));
    const ids = pages.flatMap(page => page.body.data.map(member => member.participantId));
    expect(pages.map(page => page.body.meta)).toEqual([
      { total: 60, limit: 20, offset: 0, datasetRevision: 0 },
      { total: 60, limit: 20, offset: 20, datasetRevision: 0 },
      { total: 60, limit: 20, offset: 40, datasetRevision: 0 },
    ]);
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);

    const beyond = await members('&limit=25&offset=100');
    expect(beyond.response.status).toBe(200);
    expect(beyond.body).toEqual({
      data: [], meta: { total: 60, limit: 25, offset: 100, datasetRevision: 0 },
    });
  });

  it('orders super-admins, admins, and duplicate member names deterministically', async () => {
    const all = await members('&limit=10');
    expect(all.body.data.slice(0, 3).map(member => member.participantId)).toEqual([
      'owner@c.us',
      'admin-a@c.us',
      'admin-b@c.us',
    ]);

    const filtered = await members('&query=Alpha%20Duplicate');
    expect(filtered.body.data.map(member => member.participantId)).toEqual([
      'admin-a@c.us',
      'admin-b@c.us',
      'member-a@c.us',
      'member-b@c.us',
    ]);
  });

  it.each([
    ['displayName', 'Alpha Duplicate', 4],
    ['phoneNumber', '987654', 1],
    ['participantId', 'unique-participant', 1],
  ])('searches the full synchronized dataset by %s', async (_field, query, total) => {
    const result = await members(`&limit=1&query=${encodeURIComponent(query)}`);
    expect(result.response.status).toBe(200);
    expect(result.body.data).toHaveLength(1);
    expect(result.body.meta).toEqual({ total, limit: 1, offset: 0, datasetRevision: 0 });
  });

  it('trims search, treats whitespace as no filter, and escapes SQL wildcards', async () => {
    const trimmed = await members('&query=%20%20unique-participant%20%20');
    expect(trimmed.body.meta.total).toBe(1);

    const empty = await members('&query=%20%20%20');
    expect(empty.body.meta.total).toBe(60);

    const literal = await members(`&query=${encodeURIComponent('%_')}`);
    expect(literal.body.meta.total).toBe(1);
    expect(literal.body.data[0]?.participantId).toBe('literal-wildcard@c.us');
  });

  it.each(['limit=0', 'limit=201', 'offset=-1'])(
    'rejects invalid pagination: %s',
    async invalid => {
      const { response } = await members(`&${invalid}`);
      expect(response.status).toBe(400);
    },
  );

  it('returns not found without leaking cross-session groups or missing groups', async () => {
    const crossSession = await get(
      `/groups/${encodeURIComponent(OTHER_GROUP_ID)}/members?sessionId=${INTEGRATION_SESSION_ID}`,
    );
    expect(crossSession.status).toBe(404);

    const disallowedSession = await get(
      `/groups/${encodeURIComponent(OTHER_GROUP_ID)}/members?sessionId=${DISALLOWED_SESSION_ID}`,
    );
    expect(disallowedSession.status).toBe(404);

    const missing = await get(`/groups/missing%40g.us/members?sessionId=${INTEGRATION_SESSION_ID}`);
    expect(missing.status).toBe(404);
  });
});
