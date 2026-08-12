import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../src/core/database/database.service';
import type { QueueService } from '../../src/core/queue/queue.service';
import { HealthController } from '../../src/modules/health/health.controller';

vi.mock('../../src/core/config/runtime-config', () => ({
  runtimeConfig: () => ({
    ALLOW_LIVE_SENDS: false,
    OPENWA_RELEASE_TAG: '0.15.0',
    OPENWA_ALLOWED_SESSION_IDS: ['00000000-0000-4000-8000-000000000001'],
  }),
}));

describe('HealthController readiness', () => {
  it('requires PostgreSQL, Redis, worker and scheduler', async () => {
    const database = { query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) };
    const queues = { readiness: vi.fn().mockResolvedValue({ redis: true, worker: true, scheduler: true }) };
    const controller = new HealthController(
      database as unknown as DatabaseService,
      queues as unknown as QueueService,
    );

    await expect(controller.ready()).resolves.toMatchObject({
      status: 'ready',
      dependencies: { postgres: true, redis: true, worker: true, scheduler: true },
    });
  });

  it('returns unavailable when a process heartbeat is missing', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const database = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const queues = { readiness: vi.fn().mockRejectedValue(new Error('Runtime process heartbeat missing: worker')) };
    const controller = new HealthController(
      database as unknown as DatabaseService,
      queues as unknown as QueueService,
    );

    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
