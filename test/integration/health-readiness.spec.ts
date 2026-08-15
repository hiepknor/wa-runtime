import 'reflect-metadata';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import IORedis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runtimeHeartbeatKey } from '../../src/core/queue/runtime-heartbeat';

describe('HTTP readiness', () => {
  let app: INestApplication;
  let baseUrl: string;
  let redis: IORedis;

  beforeAll(async () => {
    const { ApiAppModule } = require(resolve(process.cwd(), 'dist/src/app/api-app.module.js')) as {
      ApiAppModule: new (...args: never[]) => unknown;
    };
    app = await NestFactory.create(ApiAppModule, { rawBody: true, logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
    redis = new IORedis(process.env.REDIS_URL!);
  });

  beforeEach(async () => {
    await redis.del(runtimeHeartbeatKey('worker'), runtimeHeartbeatKey('scheduler'));
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  it('stays ready while missing background heartbeats are reported as degraded', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ready',
      dependencies: { postgres: true, redis: true },
      processes: { worker: 'degraded', scheduler: 'degraded' },
    });
  });

  it('reports fresh background heartbeats as healthy', async () => {
    await redis.set(runtimeHeartbeatKey('worker'), new Date().toISOString(), 'EX', 60);
    await redis.set(runtimeHeartbeatKey('scheduler'), new Date().toISOString(), 'EX', 60);

    const response = await fetch(`${baseUrl}/health/ready`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ready',
      dependencies: { postgres: true, redis: true },
      processes: { worker: 'healthy', scheduler: 'healthy' },
    });
  });
});
