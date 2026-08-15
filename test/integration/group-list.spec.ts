import 'reflect-metadata';
import { resolve } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DISALLOWED_SESSION_ID,
  INTEGRATION_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
} from '../support/integration-database';

interface GroupListResponse {
  data: Array<{
    id: string;
    name: string;
    description: string | null;
    participantsCount: number | null;
    isActive: boolean;
    sendCapability: { status: string; invalidatedAt: string | null };
  }>;
  meta: { total: number; limit: number; offset: number };
}

describe('group list HTTP API', () => {
  let pool: Pool;
  let app: INestApplication;
  let baseUrl: string;
  const headers = { 'x-runtime-key': process.env.RUNTIME_API_KEY! };

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
    await pool.query(
      `INSERT INTO gateway_sessions
         (id, name, status, engine_loaded, gateway_created_at, gateway_updated_at)
       VALUES ($1, 'Allowed', 'ready', true, now(), now()),
              ($2, 'Disallowed', 'ready', true, now(), now())`,
      [INTEGRATION_SESSION_ID, DISALLOWED_SESSION_ID],
    );

    const groups = Array.from({ length: 36 }, (_, index) => {
      const number = index.toString().padStart(2, '0');
      const status = index % 3 === 0 ? 'ALLOWED' : index % 3 === 1 ? 'DENIED' : 'UNKNOWN';
      return {
        id: `1203630000000000${number}@g.us`,
        name: index === 28 || index === 29 ? 'Duplicate Name'
          : index === 30 ? 'Zulu Moderator Circle' : `Team ${number}`,
        description: index === 31 ? 'Regional MODERATOR desk' : index === 32 ? 'literal 100%_match' : `Description ${number}`,
        active: index < 33,
        participantsCount: index === 27 || index === 35 ? null : index * 10,
        status,
        stale: index % 2 === 1,
      };
    });
    for (const group of groups) {
      await pool.query(
        `INSERT INTO gateway_groups
           (session_id, id, name, description, participants_count, is_active, send_capability,
            send_capability_reason, capability_checked_at, capability_invalidated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'TEST', now(), CASE WHEN $8 THEN now() ELSE NULL END)`,
        [INTEGRATION_SESSION_ID, group.id, group.name, group.description, group.participantsCount,
          group.active, group.status, group.stale],
      );
    }
    await pool.query(
      `INSERT INTO gateway_groups
         (session_id, id, name, description, send_capability, send_capability_reason, capability_checked_at)
       VALUES ($1, '120363999999999999@g.us', 'Secret Moderator', 'hidden', 'ALLOWED', 'TEST', now())`,
      [DISALLOWED_SESSION_ID],
    );
  });

  afterAll(async () => { await app.close(); await pool.end(); });

  async function request(params: Record<string, string> = {}, authenticated = true) {
    const search = new URLSearchParams({ sessionId: INTEGRATION_SESSION_ID, ...params });
    const response = await fetch(`${baseUrl}/groups?${search}`, { headers: authenticated ? headers : {} });
    const body = await response.json() as GroupListResponse;
    return { response, body };
  }

  it('preserves active-only defaults and supports custom deterministic pagination', async () => {
    const defaults = await request();
    expect(defaults.response.status).toBe(200);
    expect(defaults.body.meta).toEqual({ total: 33, limit: 50, offset: 0 });
    expect(defaults.body.data).toHaveLength(33);
    expect(defaults.body.data.every(group => group.isActive)).toBe(true);

    const first = await request({ limit: '10', offset: '0' });
    const second = await request({ limit: '10', offset: '10' });
    expect(first.body.meta).toEqual({ total: 33, limit: 10, offset: 0 });
    expect(second.body.meta).toEqual({ total: 33, limit: 10, offset: 10 });
    expect(new Set([...first.body.data, ...second.body.data].map(group => group.id)).size).toBe(20);
    const allPages = await Promise.all([0, 10, 20, 30].map(offset => request({ limit: '10', offset: String(offset) })));
    const allIds = allPages.flatMap(page => page.body.data.map(group => group.id));
    expect(allIds).toHaveLength(33);
    expect(new Set(allIds).size).toBe(33);
    expect(first.body.data.map(group => [group.name, group.id])).toEqual(
      [...first.body.data].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
        .map(group => [group.name, group.id]),
    );

    const duplicatePage = await request({ limit: '2', offset: '0', query: 'duplicate name' });
    expect(duplicatePage.body.data.map(group => group.id)).toEqual([
      '120363000000000028@g.us',
      '120363000000000029@g.us',
    ]);
  });

  it('searches name, ID, and description globally with trimmed case-insensitive literal semantics', async () => {
    const name = await request({ limit: '5', query: '  moderator  ' });
    expect(name.body.meta.total).toBe(2);
    expect(name.body.data.map(group => group.name)).toEqual(['Team 31', 'Zulu Moderator Circle']);

    const id = await request({ query: '0000000030@G.US' });
    expect(id.body.data.map(group => group.name)).toEqual(['Zulu Moderator Circle']);

    const description = await request({ query: 'regional moderator' });
    expect(description.body.data.map(group => group.name)).toEqual(['Team 31']);

    const literal = await request({ query: '100%_match' });
    expect(literal.body.data.map(group => group.name)).toEqual(['Team 32']);

    const empty = await request({ query: '   ' });
    expect(empty.body.meta.total).toBe(33);
  });

  it('filters status with OR semantics and combines filter types with AND semantics', async () => {
    for (const status of ['ALLOWED', 'DENIED', 'UNKNOWN']) {
      const single = await request({ capabilityStatus: status });
      expect(single.body.meta.total).toBe(11);
      expect(single.body.data.every(group => group.sendCapability.status === status)).toBe(true);
    }

    const multiple = await request({ capabilityStatus: 'DENIED,UNKNOWN' });
    expect(multiple.body.meta.total).toBe(22);

    const combined = await request({
      query: 'team', capabilityStatus: 'DENIED,UNKNOWN', capabilityFreshness: 'STALE', isActive: 'true',
    });
    expect(combined.body.meta.total).toBe(10);
    expect(combined.body.data.every(group =>
      group.isActive && group.sendCapability.status !== 'ALLOWED' && group.sendCapability.invalidatedAt !== null,
    )).toBe(true);
  });

  it('uses capability invalidation as authoritative CURRENT/STALE freshness', async () => {
    const current = await request({ capabilityFreshness: 'CURRENT' });
    const stale = await request({ capabilityFreshness: 'STALE' });
    const either = await request({ capabilityFreshness: 'CURRENT,STALE' });
    expect(current.body.meta.total).toBe(17);
    expect(stale.body.meta.total).toBe(16);
    expect(either.body.meta.total).toBe(33);
    expect(current.body.data.every(group => group.sendCapability.invalidatedAt === null)).toBe(true);
    expect(stale.body.data.every(group => group.sendCapability.invalidatedAt !== null)).toBe(true);
  });

  it('filters inactive records and returns valid empty/out-of-range pages with filtered totals', async () => {
    const active = await request({ isActive: 'true' });
    expect(active.body.meta.total).toBe(33);
    expect(active.body.data.every(group => group.isActive)).toBe(true);

    const inactive = await request({ isActive: 'false' });
    expect(inactive.body.meta.total).toBe(3);
    expect(inactive.body.data.every(group => !group.isActive)).toBe(true);

    const outOfRange = await request({ capabilityStatus: 'ALLOWED', limit: '10', offset: '1000' });
    expect(outOfRange.body.data).toEqual([]);
    expect(outOfRange.body.meta).toEqual({ total: 11, limit: 10, offset: 1000 });

    const empty = await request({ query: 'no such synchronized group' });
    expect(empty.body).toEqual({ data: [], meta: { total: 0, limit: 50, offset: 0 } });
  });

  it('keeps inactive durable groups readable while rejecting capability refresh', async () => {
    const groupId = '120363000000000033@g.us';
    const detail = await fetch(
      `${baseUrl}/groups/${groupId}?sessionId=${INTEGRATION_SESSION_ID}`,
      { headers },
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ id: groupId, isActive: false });

    const members = await fetch(
      `${baseUrl}/groups/${groupId}/members?sessionId=${INTEGRATION_SESSION_ID}`,
      { headers },
    );
    expect(members.status).toBe(200);
    expect(await members.json()).toMatchObject({
      data: [], meta: { total: 0, limit: 50, offset: 0 },
    });

    const refresh = await fetch(
      `${baseUrl}/groups/${groupId}/refresh-capability?sessionId=${INTEGRATION_SESSION_ID}`,
      { method: 'POST', headers },
    );
    expect(refresh.status).toBe(404);
    expect(await refresh.json()).toMatchObject({ code: 'GROUP_NOT_FOUND' });
  });

  it('supports inclusive minimum, maximum, exact, and combined participant bounds including zero', async () => {
    const zero = await request({ minParticipants: '0' });
    expect(zero.body.meta.total).toBe(32);
    expect(zero.body.data.every(group => group.participantsCount !== null)).toBe(true);

    const minimum = await request({ minParticipants: '50' });
    expect(minimum.body.meta.total).toBe(27);
    expect(minimum.body.data.every(group => group.participantsCount !== null && group.participantsCount >= 50)).toBe(true);
    expect(minimum.body.data.some(group => group.participantsCount === 50)).toBe(true);

    const maximum = await request({ maxParticipants: '50' });
    expect(maximum.body.meta.total).toBe(6);
    expect(maximum.body.data.every(group => group.participantsCount !== null && group.participantsCount <= 50)).toBe(true);
    expect(maximum.body.data.some(group => group.participantsCount === 50)).toBe(true);

    const exact = await request({ minParticipants: '100', maxParticipants: '100' });
    expect(exact.body.data.map(group => group.participantsCount)).toEqual([100]);

    const range = await request({ minParticipants: '50', maxParticipants: '100' });
    expect(range.body.meta.total).toBe(6);
    expect(range.body.data.map(group => group.participantsCount).sort((left, right) => left! - right!))
      .toEqual([50, 60, 70, 80, 90, 100]);
  });

  it('keeps unknown participant counts only when no participant bound is present', async () => {
    const omitted = await request();
    expect(omitted.body.meta.total).toBe(33);
    expect(omitted.body.data.some(group => group.participantsCount === null)).toBe(true);

    const minimum = await request({ minParticipants: '0' });
    const maximum = await request({ maxParticipants: '1000' });
    expect(minimum.body.data.some(group => group.participantsCount === null)).toBe(false);
    expect(maximum.body.data.some(group => group.participantsCount === null)).toBe(false);
  });

  it('ANDs participant bounds with search, capability, freshness, and explicit active state', async () => {
    const search = await request({ query: 'moderator', minParticipants: '305', maxParticipants: '315' });
    expect(search.body.data.map(group => group.name)).toEqual(['Team 31']);

    const oneCapability = await request({ capabilityStatus: 'DENIED', minParticipants: '50', maxParticipants: '100' });
    expect(oneCapability.body.meta.total).toBe(2);

    const multipleCapabilities = await request({
      capabilityStatus: 'DENIED,UNKNOWN', minParticipants: '50', maxParticipants: '100',
    });
    expect(multipleCapabilities.body.meta.total).toBe(4);

    const freshness = await request({
      capabilityFreshness: 'STALE', minParticipants: '50', maxParticipants: '100',
    });
    expect(freshness.body.meta.total).toBe(3);

    const active = await request({ isActive: 'true', minParticipants: '330', maxParticipants: '350' });
    expect(active.body.meta.total).toBe(0);
    const inactive = await request({ isActive: 'false', minParticipants: '330', maxParticipants: '350' });
    expect(inactive.body.meta.total).toBe(2);
    expect(inactive.body.data.every(group => !group.isActive)).toBe(true);

    const all = await request({
      query: 'team', capabilityStatus: 'DENIED,UNKNOWN', capabilityFreshness: 'STALE',
      isActive: 'true', minParticipants: '50', maxParticipants: '200',
    });
    expect(all.body.meta.total).toBe(6);
  });

  it('applies participant filters before stable pagination and reports the filtered total', async () => {
    const pages = await Promise.all([0, 7, 14].map(offset => request({
      minParticipants: '50', maxParticipants: '250', limit: '7', offset: String(offset),
    })));
    expect(pages.every(page => page.body.meta.total === 21)).toBe(true);
    const ids = pages.flatMap(page => page.body.data.map(group => group.id));
    expect(ids).toHaveLength(21);
    expect(new Set(ids).size).toBe(21);
    const ordered = pages.flatMap(page => page.body.data.map(group => [group.name, group.id] as const));
    expect(ordered).toEqual([...ordered].sort((left, right) =>
      left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]),
    ));
  });

  it.each([
    ['minParticipants', '-1'],
    ['maxParticipants', '-1'],
    ['minParticipants', '1.5'],
    ['maxParticipants', '1.5'],
    ['minParticipants', 'NaN'],
    ['maxParticipants', 'not-a-number'],
    ['minParticipants', '2147483648'],
    ['maxParticipants', '2147483648'],
  ] as const)('returns a typed error for invalid %s=%s', async (field, value) => {
    const result = await request({ [field]: value });
    expect(result.response.status).toBe(400);
    expect(result.body as unknown).toMatchObject({
      code: 'GROUP_FILTER_PARTICIPANTS_INVALID',
      fieldErrors: { [field]: expect.any(Array) },
      details: {},
    });
  });

  it('returns a typed error when the participant range is inverted', async () => {
    const result = await request({ minParticipants: '101', maxParticipants: '100' });
    expect(result.response.status).toBe(400);
    expect(result.body as unknown).toEqual({
      code: 'GROUP_FILTER_PARTICIPANTS_RANGE_INVALID',
      message: 'Participant count filter range is invalid.',
      fieldErrors: {
        minParticipants: ['Must be less than or equal to maxParticipants.'],
        maxParticipants: ['Must be greater than or equal to minParticipants.'],
      },
      details: {},
    });
  });

  it.each<Record<string, string>>([
    { limit: '0' },
    { limit: '201' },
    { offset: '-1' },
    { capabilityStatus: 'INVALID' },
    { capabilityStatus: '' },
    { capabilityFreshness: 'OLD' },
    { capabilityFreshness: '' },
    { isActive: 'yes' },
  ])('rejects invalid filters: %j', async params => {
    expect((await request(params)).response.status).toBe(400);
  });

  it('preserves authentication and session isolation', async () => {
    expect((await request({}, false)).response.status).toBe(401);
    const hidden = await fetch(`${baseUrl}/groups?sessionId=${DISALLOWED_SESSION_ID}&query=moderator`, { headers });
    expect(hidden.status).toBe(404);
  });

  it('rejects repeated scalar search parameters', async () => {
    const response = await fetch(
      `${baseUrl}/groups?sessionId=${INTEGRATION_SESSION_ID}&query=one&query=two`,
      { headers },
    );
    expect(response.status).toBe(400);
  });

  it('rejects oversized group and member searches with the typed group error contract', async () => {
    const list = await request({ query: 'x'.repeat(201) });
    expect(list.response.status).toBe(400);
    expect(list.body as unknown).toMatchObject({
      code: 'GROUP_QUERY_INVALID', fieldErrors: { query: expect.any(Array) },
    });

    const memberResponse = await fetch(
      `${baseUrl}/groups/120363000000000000@g.us/members?sessionId=${INTEGRATION_SESSION_ID}&query=${'x'.repeat(201)}`,
      { headers },
    );
    expect(memberResponse.status).toBe(400);
    expect(await memberResponse.json()).toMatchObject({
      code: 'GROUP_QUERY_INVALID', fieldErrors: { query: expect.any(Array) },
    });
  });
});
