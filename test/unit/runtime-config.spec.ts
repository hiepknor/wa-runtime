import { describe, expect, it } from 'vitest';
import { parseRuntimeConfig } from '../../src/core/config/runtime-config';

const validEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://runtime:runtime@postgres.test:5432/runtime',
  REDIS_URL: 'redis://redis.test:6379',
  RUNTIME_API_KEY: 'runtime-key-with-at-least-32-characters',
  OPENWA_BASE_URL: 'http://openwa.test:2785',
  OPENWA_API_KEY: 'openwa-key',
  OPENWA_WEBHOOK_SECRET: 'webhook-secret-with-at-least-32-characters',
  OPENWA_ALLOWED_SESSION_IDS: '00000000-0000-4000-8000-000000000001',
});

describe('runtime worker concurrency configuration', () => {
  it('preserves the established per-queue defaults', () => {
    const config = parseRuntimeConfig(validEnvironment());

    expect(config).toMatchObject({
      MESSAGE_WORKER_CONCURRENCY: 1,
      WEBHOOK_WORKER_CONCURRENCY: 10,
      GATEWAY_WORKER_CONCURRENCY: 1,
      CAMPAIGN_WORKER_CONCURRENCY: 2,
      RUNTIME_EVENT_RETENTION_DAYS: 30,
      RUNTIME_INBOX_RETENTION_DAYS: 30,
      RUNTIME_COMPACT_EVENT_PAYLOAD_ENABLED: false,
      RUNTIME_COMPACT_PROCESSED_WEBHOOK_PAYLOAD_ENABLED: false,
    });
  });

  it('allows inbox history to be shorter without silently changing existing deployments', () => {
    expect(parseRuntimeConfig({
      ...validEnvironment(),
      RUNTIME_EVENT_RETENTION_DAYS: '60',
    }).RUNTIME_INBOX_RETENTION_DAYS).toBe(60);
    expect(parseRuntimeConfig({
      ...validEnvironment(),
      RUNTIME_EVENT_RETENTION_DAYS: '60',
      RUNTIME_INBOX_RETENTION_DAYS: '7',
    }).RUNTIME_INBOX_RETENTION_DAYS).toBe(7);
  });

  it.each([
    ['MESSAGE_WORKER_CONCURRENCY', '0'],
    ['WEBHOOK_WORKER_CONCURRENCY', '101'],
    ['GATEWAY_WORKER_CONCURRENCY', '1.5'],
    ['CAMPAIGN_WORKER_CONCURRENCY', 'not-a-number'],
  ])('rejects invalid %s values', (name, value) => {
    expect(() => parseRuntimeConfig({ ...validEnvironment(), [name]: value })).toThrow();
  });
});
