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
  seedSendableGroup,
} from '../support/integration-database';

interface CampaignListResponse {
  data: Array<{
    id: string;
    name: string;
    text: string;
    status: string;
    scheduleType: string;
    updatedAt: string;
  }>;
  meta: { total: number; limit: number; offset: number };
}

const campaignIds = Array.from(
  { length: 8 },
  (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);

describe('campaign list search and filters', () => {
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
    await pool.query(
      `INSERT INTO gateway_sessions
         (id, name, status, engine_loaded, gateway_created_at, gateway_updated_at)
       VALUES ($1, 'Disallowed', 'ready', true, now(), now())`,
      [DISALLOWED_SESSION_ID],
    );
    const fixtures = [
      ['Release Alpha', 'DRAFT', 'IMMEDIATE', null, 'ordinary text', '2030-01-08T00:00:00Z'],
      ['release Beta', 'PAUSED', 'ONCE', '2031-01-01T00:00:00Z', 'ordinary text', '2030-01-08T00:00:00Z'],
      ['100% Ready', 'ACTIVE', 'IMMEDIATE', null, 'ordinary text', '2030-01-07T00:00:00Z'],
      ['100x Ready', 'DRAFT', 'IMMEDIATE', null, 'ordinary text', '2030-01-06T00:00:00Z'],
      ['Under_score', 'ARCHIVED', 'ONCE', '2031-01-01T00:00:00Z', 'ordinary text', '2030-01-05T00:00:00Z'],
      ['UnderXscore', 'ACTIVE', 'IMMEDIATE', null, 'ordinary text', '2030-01-04T00:00:00Z'],
      ['Plain Campaign', 'DRAFT', 'ONCE', '2031-01-01T00:00:00Z', 'secretneedle', '2030-01-03T00:00:00Z'],
      ['Another Campaign', 'PAUSED', 'IMMEDIATE', null, 'ordinary text', '2030-01-02T00:00:00Z'],
    ] as const;
    for (const [index, fixture] of fixtures.entries()) {
      const [name, status, scheduleType, scheduledAt, text, updatedAt] = fixture;
      await pool.query(
        `INSERT INTO campaigns
           (id, session_id, name, payload, schedule_type, scheduled_at, status, created_at, updated_at)
         VALUES ($1,$2,$3,jsonb_build_object('text',$4::text),$5,$6,$7,$8,$8)`,
        [campaignIds[index], INTEGRATION_SESSION_ID, name, text, scheduleType, scheduledAt, status, updatedAt],
      );
    }
    await pool.query(
      `INSERT INTO campaigns (session_id, name, payload, status)
       VALUES ($1, 'Release Secret', '{"text":"hidden"}'::jsonb, 'DRAFT')`,
      [DISALLOWED_SESSION_ID],
    );
  });

  afterAll(async () => { await app.close(); await pool.end(); });

  async function request(entries: Record<string, string> = {}) {
    const params = new URLSearchParams(entries);
    const response = await fetch(`${baseUrl}/campaigns?${params}`, { headers: auth });
    return { response, body: await response.json() as CampaignListResponse & Record<string, any> };
  }

  it('preserves unfiltered behavior and deterministic updatedAt/id pagination', async () => {
    const unfiltered = await request();
    expect(unfiltered.response.status).toBe(200);
    expect(unfiltered.body.meta).toEqual({ total: 8, limit: 50, offset: 0 });
    expect(unfiltered.body.data.slice(0, 2).map(campaign => campaign.id)).toEqual(campaignIds.slice(0, 2));

    const pages = await Promise.all([0, 2, 4, 6].map(offset => request({ limit: '2', offset: String(offset) })));
    const ids = pages.flatMap(page => page.body.data.map(campaign => campaign.id));
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    expect(pages.every(page => page.body.meta.total === 8)).toBe(true);
  });

  it('searches trimmed names case-insensitively and exact UUIDs without searching message text', async () => {
    const names = await request({ sessionId: INTEGRATION_SESSION_ID, query: '  ReLeAsE  ' });
    expect(names.body.data.map(campaign => campaign.name)).toEqual(['Release Alpha', 'release Beta']);
    expect(names.body.meta.total).toBe(2);

    const exactId = await request({ query: campaignIds[6]! });
    expect(exactId.body.data.map(campaign => campaign.id)).toEqual([campaignIds[6]]);
    const partialId = await request({ query: campaignIds[6]!.slice(0, 12) });
    expect(partialId.body.data).toEqual([]);
    const messageText = await request({ query: 'secretneedle' });
    expect(messageText.body.data).toEqual([]);

    const empty = await request({ query: '   ' });
    expect(empty.body.meta.total).toBe(8);
  });

  it('treats percent, underscore, and backslash as literal search characters', async () => {
    const percent = await request({ query: '%' });
    expect(percent.body.data.map(campaign => campaign.name)).toEqual(['100% Ready']);
    const underscore = await request({ query: '_' });
    expect(underscore.body.data.map(campaign => campaign.name)).toEqual(['Under_score']);
    const backslash = await request({ query: '\\' });
    expect(backslash.body.data).toEqual([]);
  });

  it('uses OR within filters, AND across filters, and treats empty arrays as omitted', async () => {
    const draft = await request({ status: 'DRAFT' });
    expect(draft.body.meta.total).toBe(3);
    expect(draft.body.data.every(campaign => campaign.status === 'DRAFT')).toBe(true);

    const statuses = await request({ status: 'DRAFT,PAUSED' });
    expect(statuses.body.meta.total).toBe(5);
    const once = await request({ scheduleType: 'ONCE' });
    expect(once.body.meta.total).toBe(3);
    const schedules = await request({ scheduleType: 'IMMEDIATE,ONCE' });
    expect(schedules.body.meta.total).toBe(8);

    const combined = await request({ query: 'release', status: 'DRAFT,PAUSED', scheduleType: 'ONCE' });
    expect(combined.body.data.map(campaign => campaign.name)).toEqual(['release Beta']);
    expect(combined.body.meta.total).toBe(1);

    const empty = await request({ status: '', scheduleType: '' });
    expect(empty.body.meta.total).toBe(8);
  });

  it('applies filters before pagination and returns filtered totals', async () => {
    const first = await request({ status: 'DRAFT', limit: '1', offset: '0' });
    const second = await request({ status: 'DRAFT', limit: '1', offset: '1' });
    expect(first.body.meta).toEqual({ total: 3, limit: 1, offset: 0 });
    expect(second.body.meta).toEqual({ total: 3, limit: 1, offset: 1 });
    expect(first.body.data[0]?.id).not.toBe(second.body.data[0]?.id);
  });

  it('returns field-specific typed errors for invalid filters and oversized queries', async () => {
    const invalidStatus = await request({ status: 'DRAFT,INVALID' });
    expect(invalidStatus.response.status).toBe(400);
    expect(invalidStatus.body).toMatchObject({
      code: 'CAMPAIGN_FILTER_STATUS_INVALID', fieldErrors: { status: expect.any(Array) },
    });
    const invalidSchedule = await request({ scheduleType: 'WEEKLY' });
    expect(invalidSchedule.response.status).toBe(400);
    expect(invalidSchedule.body).toMatchObject({
      code: 'CAMPAIGN_FILTER_SCHEDULE_TYPE_INVALID', fieldErrors: { scheduleType: expect.any(Array) },
    });
    const oversized = await request({ query: 'x'.repeat(201) });
    expect(oversized.response.status).toBe(400);
    expect(oversized.body).toMatchObject({
      code: 'CAMPAIGN_QUERY_INVALID', fieldErrors: { query: expect.any(Array) },
    });

    expect((await request({ limit: '0' })).response.status).toBe(400);
    expect((await request({ offset: '-1' })).response.status).toBe(400);
  });

  it('keeps session isolation and causes no campaign execution side effects', async () => {
    const release = await request({ query: 'release' });
    expect(release.body.meta.total).toBe(2);
    expect(release.body.data.every(campaign => campaign.name !== 'Release Secret')).toBe(true);
    const counts = await pool.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM campaign_runs)::text AS runs,
         (SELECT count(*) FROM campaign_run_targets)::text AS run_targets,
         (SELECT count(*) FROM campaign_deliveries)::text AS deliveries,
         (SELECT count(*) FROM message_jobs)::text AS jobs`,
    );
    expect(counts.rows[0]).toEqual({ runs: '0', run_targets: '0', deliveries: '0', jobs: '0' });
  });

  it('keeps Groups target-picker access to inactive, denied, and unknown records', async () => {
    await pool.query(
      `INSERT INTO gateway_groups
         (session_id, id, name, is_active, send_capability, send_capability_reason)
       VALUES ($1, 'inactive-denied@g.us', 'Inactive denied picker', false, 'DENIED', 'GROUP_INACTIVE'),
              ($1, 'active-unknown@g.us', 'Active unknown picker', true, 'UNKNOWN', 'METADATA_INCOMPLETE')`,
      [INTEGRATION_SESSION_ID],
    );
    const inactive = await fetch(
      `${baseUrl}/groups?${new URLSearchParams({
        sessionId: INTEGRATION_SESSION_ID, query: 'picker', isActive: 'false', capabilityStatus: 'DENIED',
      })}`,
      { headers: auth },
    ).then(response => response.json()) as { data: Array<{ id: string }> };
    const unknown = await fetch(
      `${baseUrl}/groups?${new URLSearchParams({
        sessionId: INTEGRATION_SESSION_ID, query: 'picker', isActive: 'true', capabilityStatus: 'UNKNOWN',
      })}`,
      { headers: auth },
    ).then(response => response.json()) as { data: Array<{ id: string }> };
    expect(inactive.data.map(group => group.id)).toEqual(['inactive-denied@g.us']);
    expect(unknown.data.map(group => group.id)).toEqual(['active-unknown@g.us']);
  });
});
