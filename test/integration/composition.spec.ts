import 'reflect-metadata';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

describe('process composition', () => {
  it.each([
    ['worker', 'WorkerAppModule', 'dist/src/app/worker-app.module.js'],
    ['scheduler', 'SchedulerAppModule', 'dist/src/app/scheduler-app.module.js'],
  ] as const)('boots and closes the %s application context', async (_processName, exportName, modulePath) => {
    const loaded = require(resolve(process.cwd(), modulePath)) as Record<string, new (...args: never[]) => unknown>;
    const app = await NestFactory.createApplicationContext(loaded[exportName]!, { logger: false });

    expect(app).toBeDefined();
    await app.close();
  });
});
