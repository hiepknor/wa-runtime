import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { messageRequestHash } from '../../src/modules/messages/message-idempotency';
import { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import { DISALLOWED_SESSION_ID, INTEGRATION_GROUP_ID, integrationPool, resetIntegrationDatabase, seedSendableGroup } from '../support/integration-database';
import { INTEGRATION_SESSION_ID } from '../support/integration-database';

describe('HTTP session authorization', () => {
  let pool: Pool;
  let app: INestApplication;
  let baseUrl: string;

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
  beforeEach(() => resetIntegrationDatabase(pool));
  afterAll(async () => { await app.close(); await pool.end(); });

  const runtimeHeaders = { 'x-runtime-key': process.env.RUNTIME_API_KEY! };

  it('preserves a valid request id and replaces an invalid one', async () => {
    const supplied = await fetch(`${baseUrl}/health/live`, { headers: { 'x-request-id': 'request-123' } });
    expect(supplied.headers.get('x-request-id')).toBe('request-123');

    const generated = await fetch(`${baseUrl}/health/live`, { headers: { 'x-request-id': 'not valid!' } });
    expect(generated.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('hides group reads outside the deployment session scope', async () => {
    const response = await fetch(`${baseUrl}/groups?sessionId=${DISALLOWED_SESSION_ID}`, {
      headers: { ...runtimeHeaders, 'x-request-id': 'protected-route-request' },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('x-request-id')).toBe('protected-route-request');
    expect(await response.json()).toMatchObject({ code: 'RESOURCE_NOT_FOUND', details: {} });
  });

  it('normalizes authentication and validation failures to RuntimeErrorDto', async () => {
    const unauthorized = await fetch(`${baseUrl}/sessions`);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({
      code: 'UNAUTHORIZED',
      message: 'Missing or invalid X-Runtime-Key',
      details: {},
    });

    const invalid = await fetch(`${baseUrl}/messages?sessionId=${INTEGRATION_SESSION_ID}&limit=0`, {
      headers: runtimeHeaders,
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      fieldErrors: { limit: expect.any(Array) },
      details: {},
    });
  });

  it('rejects a validly signed webhook for a disallowed session', async () => {
    const body = JSON.stringify({
      event: 'session.status', timestamp: '2026-08-11T00:00:00.000Z',
      sessionId: DISALLOWED_SESSION_ID, idempotencyKey: 'disallowed-webhook',
      deliveryId: 'delivery-disallowed', data: { status: 'ready' },
    });
    const signature = `sha256=${createHmac('sha256', process.env.OPENWA_WEBHOOK_SECRET!).update(body).digest('hex')}`;
    const response = await fetch(`${baseUrl}/webhooks/openwa`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-openwa-signature': signature }, body,
    });
    expect(response.status).toBe(403);
    expect((await pool.query('SELECT count(*)::int AS count FROM webhook_events')).rows[0].count).toBe(0);
  });

  it('hides historical message jobs owned by a disallowed session', async () => {
    await seedSendableGroup(pool, DISALLOWED_SESSION_ID);
    const database = new DatabaseService();
    const messages = new MessageJobRepository(database);
    const created = await messages.create({
      idempotencyScope: 'runtime-api', idempotencyKey: 'historical-job',
      requestHash: messageRequestHash({
        sessionId: DISALLOWED_SESSION_ID, recipientId: INTEGRATION_GROUP_ID,
        text: 'hidden', scheduledAt: null, dryRun: true,
      }),
      sessionId: DISALLOWED_SESSION_ID, recipientId: INTEGRATION_GROUP_ID,
      text: 'hidden', scheduledAt: new Date(), dryRun: true,
    });

    const response = await fetch(`${baseUrl}/message-jobs/${created.job.id}`, { headers: runtimeHeaders });
    expect(response.status).toBe(404);
    await database.onApplicationShutdown();
  });

  it('validates additive sync modes and preserves the no-body FULL default', async () => {
    const noBody = await fetch(`${baseUrl}/sessions/${INTEGRATION_SESSION_ID}/sync`, {
      method: 'POST', headers: runtimeHeaders,
    });
    expect(noBody.status).toBe(202);
    expect(await noBody.json()).toMatchObject({ syncType: 'FULL', phase: 'DISCOVERING' });

    await pool.query(`UPDATE sync_runs SET status = 'COMPLETED', completed_at = now()`);
    const incremental = await fetch(`${baseUrl}/sessions/${INTEGRATION_SESSION_ID}/sync`, {
      method: 'POST',
      headers: { ...runtimeHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'INCREMENTAL' }),
    });
    expect(incremental.status).toBe(202);
    expect(await incremental.json()).toMatchObject({ syncType: 'INCREMENTAL' });

    const conflicting = await fetch(`${baseUrl}/sessions/${INTEGRATION_SESSION_ID}/sync`, {
      method: 'POST',
      headers: { ...runtimeHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'FULL' }),
    });
    expect(conflicting.status).toBe(409);
    expect(await conflicting.json()).toMatchObject({
      code: 'SYNC_MODE_CONFLICT', activeMode: 'INCREMENTAL',
    });

    const invalid = await fetch(`${baseUrl}/sessions/${INTEGRATION_SESSION_ID}/sync`, {
      method: 'POST',
      headers: { ...runtimeHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'FAST' }),
    });
    expect(invalid.status).toBe(400);
  });
});
