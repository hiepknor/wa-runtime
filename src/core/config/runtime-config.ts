import { z } from 'zod';

const booleanFromEnv = (defaultValue: boolean) => z
  .enum(['true', 'false'])
  .optional()
  .transform(value => value === undefined ? defaultValue : value === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    RUNTIME_API_KEY: z.string().min(32),
    ENABLE_RUNTIME_DOCS: z
      .enum(['true', 'false'])
      .optional()
      .transform(value => value === undefined ? undefined : value === 'true'),
    OPENWA_BASE_URL: z.string().url(),
    OPENWA_API_KEY: z.string().min(1),
    OPENWA_RELEASE_TAG: z.string().min(1).default('0.16.0'),
    OPENWA_WEBHOOK_SECRET: z.string().min(32),
    OPENWA_ALLOWED_SESSION_IDS: z
      .string()
      .min(1)
      .transform(value => value.split(',').map(item => item.trim()).filter(Boolean))
      .pipe(z.array(z.uuid()).min(1)),
    ALLOW_LIVE_SENDS: booleanFromEnv(false),
    OUTBOUND_MIN_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(3000),
    OUTBOUND_MAX_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(7000),
    RUNTIME_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
    RUNTIME_RETENTION_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
    RUNTIME_RETENTION_BATCH_SIZE: z.coerce.number().int().min(100).max(10_000).default(5000),
    GATEWAY_SYNC_GROUPS_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(40),
    GATEWAY_SYNC_ITEM_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    GATEWAY_GROUP_DETAILS_STALE_AFTER_HOURS: z.coerce.number().int().min(1).max(8760).default(24),
    GATEWAY_SYNC_SNAPSHOT_MIN_BASELINE: z.coerce.number().int().min(1).max(100_000).default(20),
    GATEWAY_SYNC_SNAPSHOT_DROP_RATIO: z.coerce.number().min(0).max(1).default(0.25),
    GATEWAY_SYNC_SNAPSHOT_CONFIRMATIONS: z.coerce.number().int().min(2).max(5).default(2),
    GATEWAY_TARGETED_RECONCILIATION_ENABLED: booleanFromEnv(false),
    GATEWAY_GROUP_EVENT_DEBOUNCE_MS: z.coerce.number().int().min(0).max(60_000).default(3_000),
    GATEWAY_GROUP_EVENT_MAX_WAIT_MS: z.coerce.number().int().min(1_000).max(300_000).default(10_000),
    GATEWAY_SYNC_NOTIFY_WAKEUP_ENABLED: booleanFromEnv(false),
    GATEWAY_SYNC_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
    GATEWAY_SYNC_ADAPTIVE_PACING: booleanFromEnv(false),
    GATEWAY_SYNC_MIN_GROUPS_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(5),
    GATEWAY_SYNC_RATE_RECOVERY_SUCCESSES: z.coerce.number().int().min(1).max(1_000).default(25),
  })
  .superRefine((value, context) => {
    if (value.OUTBOUND_MAX_DELAY_MS < value.OUTBOUND_MIN_DELAY_MS) {
      context.addIssue({
        code: 'custom',
        path: ['OUTBOUND_MAX_DELAY_MS'],
        message: 'must be greater than or equal to OUTBOUND_MIN_DELAY_MS',
      });
    }
    if (value.GATEWAY_GROUP_EVENT_MAX_WAIT_MS < value.GATEWAY_GROUP_EVENT_DEBOUNCE_MS) {
      context.addIssue({
        code: 'custom', path: ['GATEWAY_GROUP_EVENT_MAX_WAIT_MS'],
        message: 'GATEWAY_GROUP_EVENT_MAX_WAIT_MS must be greater than or equal to GATEWAY_GROUP_EVENT_DEBOUNCE_MS',
      });
    }
    if (value.GATEWAY_SYNC_MIN_GROUPS_PER_MINUTE > value.GATEWAY_SYNC_GROUPS_PER_MINUTE) {
      context.addIssue({
        code: 'custom', path: ['GATEWAY_SYNC_MIN_GROUPS_PER_MINUTE'],
        message: 'GATEWAY_SYNC_MIN_GROUPS_PER_MINUTE cannot exceed GATEWAY_SYNC_GROUPS_PER_MINUTE',
      });
    }
  });

export type RuntimeConfig = z.infer<typeof schema> & { enableRuntimeDocs: boolean };

let cached: RuntimeConfig | undefined;

export function runtimeConfig(): RuntimeConfig {
  if (cached) return cached;
  const parsed = schema.parse(process.env);
  cached = {
    ...parsed,
    enableRuntimeDocs: parsed.ENABLE_RUNTIME_DOCS ?? parsed.NODE_ENV !== 'production',
  };
  return cached;
}
