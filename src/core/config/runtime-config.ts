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
    OPENWA_WEBHOOK_RECONCILIATION_ENABLED: booleanFromEnv(false),
    OPENWA_WEBHOOK_CALLBACK_URL: z.url().optional(),
    OPENWA_WEBHOOK_RECONCILIATION_INTERVAL_MS: z.coerce.number().int()
      .min(60_000).max(86_400_000).default(300_000),
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
    CONTACT_SNAPSHOT_SYNC_ENABLED: booleanFromEnv(false),
    CONTACT_SNAPSHOT_STAGING_ENABLED: booleanFromEnv(false),
    CONTACT_SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().min(7).max(365).default(30),
    CONTACT_EVIDENCE_DUAL_WRITE_ENABLED: booleanFromEnv(false),
    CONTACT_RESOLUTION_SHADOW_ENABLED: booleanFromEnv(false),
    CONTACT_RESOLUTION_MAX_RUNS_PER_TICK: z.coerce.number().int().min(1).max(20).default(2),
    CONTACT_PROJECTION_SHADOW_ENABLED: booleanFromEnv(false),
    CONTACT_PROJECTION_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(500),
    CONTACT_PROJECTION_MAX_JOBS_PER_TICK: z.coerce.number().int().min(1).max(100).default(10),
    CONTACT_PROJECTION_MAX_BATCHES_PER_JOB: z.coerce.number().int().min(1).max(100).default(4),
    CONTACT_MESSAGE_ENRICHMENT_ENABLED: booleanFromEnv(false),
    CONTACT_PERIODIC_SYNC_ENABLED: booleanFromEnv(false),
    CONTACT_PERIODIC_SYNC_INTERVAL_MS: z.coerce.number().int().min(300_000).default(86_400_000),
    CONTACT_MEMBER_IDENTITY_BACKFILL_ENABLED: booleanFromEnv(false),
    CONTACT_MEMBER_IDENTITY_BACKFILL_BATCH_SIZE: z.coerce.number().int().min(100).max(10_000).default(1000),
    CONTACT_MEMBER_IDENTITY_BACKFILL_MAX_BATCHES: z.coerce.number().int().min(1).max(100).default(20),
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
    if (value.OPENWA_WEBHOOK_RECONCILIATION_ENABLED && !value.OPENWA_WEBHOOK_CALLBACK_URL) {
      context.addIssue({
        code: 'custom', path: ['OPENWA_WEBHOOK_CALLBACK_URL'],
        message: 'OPENWA_WEBHOOK_CALLBACK_URL is required when webhook reconciliation is enabled',
      });
    }
    if (value.OPENWA_WEBHOOK_CALLBACK_URL
      && new URL(value.OPENWA_WEBHOOK_CALLBACK_URL).protocol !== 'https:') {
      context.addIssue({
        code: 'custom', path: ['OPENWA_WEBHOOK_CALLBACK_URL'],
        message: 'OPENWA_WEBHOOK_CALLBACK_URL must use HTTPS',
      });
    }
    if (value.OPENWA_WEBHOOK_CALLBACK_URL) {
      const callback = new URL(value.OPENWA_WEBHOOK_CALLBACK_URL);
      const path = callback.pathname.replace(/\/+$/u, '');
      if (path !== '/api/v1/webhooks/openwa' || callback.search || callback.hash
        || callback.username || callback.password) {
        context.addIssue({
          code: 'custom', path: ['OPENWA_WEBHOOK_CALLBACK_URL'],
          message: 'OPENWA_WEBHOOK_CALLBACK_URL must target /api/v1/webhooks/openwa without credentials, query or fragment',
        });
      }
    }
    if (value.CONTACT_EVIDENCE_DUAL_WRITE_ENABLED && !value.CONTACT_SNAPSHOT_STAGING_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['CONTACT_EVIDENCE_DUAL_WRITE_ENABLED'],
        message: 'CONTACT_EVIDENCE_DUAL_WRITE_ENABLED requires CONTACT_SNAPSHOT_STAGING_ENABLED',
      });
    }
    if (value.CONTACT_RESOLUTION_SHADOW_ENABLED && !value.CONTACT_EVIDENCE_DUAL_WRITE_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['CONTACT_RESOLUTION_SHADOW_ENABLED'],
        message: 'CONTACT_RESOLUTION_SHADOW_ENABLED requires CONTACT_EVIDENCE_DUAL_WRITE_ENABLED',
      });
    }
    if (value.CONTACT_PROJECTION_SHADOW_ENABLED && !value.CONTACT_RESOLUTION_SHADOW_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['CONTACT_PROJECTION_SHADOW_ENABLED'],
        message: 'CONTACT_PROJECTION_SHADOW_ENABLED requires CONTACT_RESOLUTION_SHADOW_ENABLED',
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
