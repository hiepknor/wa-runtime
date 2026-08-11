CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE TYPE message_job_status AS ENUM (
    'SCHEDULED',
    'QUEUED',
    'PROCESSING',
    'ACCEPTED',
    'SENT',
    'DELIVERED',
    'READ',
    'FAILED',
    'UNKNOWN',
    'DRY_RUN_COMPLETED',
    'CANCELLED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS message_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  session_id text NOT NULL,
  recipient_id text NOT NULL,
  message_type text NOT NULL DEFAULT 'text',
  payload jsonb NOT NULL,
  scheduled_at timestamptz NOT NULL,
  status message_job_status NOT NULL DEFAULT 'SCHEDULED',
  dry_run boolean NOT NULL DEFAULT true,
  attempt_count integer NOT NULL DEFAULT 0,
  openwa_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_jobs_schedule
  ON message_jobs (scheduled_at, status)
  WHERE status = 'SCHEDULED';

CREATE INDEX IF NOT EXISTS idx_message_jobs_openwa_message_id
  ON message_jobs (openwa_message_id)
  WHERE openwa_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_job_id uuid NOT NULL REFERENCES message_jobs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  outcome text NOT NULL,
  response jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_job_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  delivery_id text,
  event_type text NOT NULL,
  session_id text,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  processing_error text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_unprocessed
  ON webhook_events (received_at)
  WHERE processed_at IS NULL;
