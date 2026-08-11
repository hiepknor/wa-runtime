import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform(value => value === 'true');

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
    OPENWA_RELEASE_TAG: z.string().min(1).default('0.15.0'),
    OPENWA_WEBHOOK_SECRET: z.string().min(32),
    ALLOW_LIVE_SENDS: booleanString,
    OUTBOUND_MIN_DELAY_MS: z.coerce.number().int().min(0).default(3000),
    OUTBOUND_MAX_DELAY_MS: z.coerce.number().int().min(0).default(7000),
  })
  .superRefine((value, context) => {
    if (value.OUTBOUND_MAX_DELAY_MS < value.OUTBOUND_MIN_DELAY_MS) {
      context.addIssue({
        code: 'custom',
        path: ['OUTBOUND_MAX_DELAY_MS'],
        message: 'must be greater than or equal to OUTBOUND_MIN_DELAY_MS',
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
