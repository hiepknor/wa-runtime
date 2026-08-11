DO $$ BEGIN
  CREATE TYPE campaign_execution_mode AS ENUM ('DRY_RUN', 'LIVE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE campaign_run_status AS ENUM (
    'PREPARING', 'BLOCKED', 'SCHEDULED', 'RUNNING', 'PAUSED',
    'COMPLETED', 'PARTIAL_FAILED', 'CANCELLED', 'FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE campaign_delivery_status AS ENUM (
    'PENDING', 'MATERIALIZED', 'PROCESSING', 'DRY_RUN_COMPLETED', 'ACCEPTED',
    'SENT', 'DELIVERED', 'READ', 'FAILED', 'UNKNOWN',
    'BLOCKED_CAPABILITY_CHANGED', 'CANCELLED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS campaign_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  session_id text NOT NULL REFERENCES gateway_sessions(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  execution_mode campaign_execution_mode NOT NULL,
  status campaign_run_status NOT NULL DEFAULT 'PREPARING',
  payload_snapshot jsonb NOT NULL,
  preflight_status text,
  preflight_policy_version integer,
  preflight_report jsonb,
  scheduled_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, idempotency_key),
  UNIQUE (id, session_id),
  CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  CHECK (jsonb_typeof(payload_snapshot) = 'object'),
  CHECK (jsonb_typeof(payload_snapshot->'text') = 'string')
);

CREATE INDEX IF NOT EXISTS idx_campaign_runs_dispatch
  ON campaign_runs (status, scheduled_at, created_at);

CREATE INDEX IF NOT EXISTS idx_campaign_runs_campaign_created
  ON campaign_runs (campaign_id, created_at DESC);

CREATE TABLE IF NOT EXISTS campaign_run_targets (
  run_id uuid NOT NULL,
  session_id text NOT NULL,
  group_id text NOT NULL,
  group_name text NOT NULL,
  capability group_send_capability NOT NULL,
  capability_reason text NOT NULL,
  capability_revision integer NOT NULL,
  capability_checked_at timestamptz,
  PRIMARY KEY (run_id, group_id),
  FOREIGN KEY (run_id, session_id)
    REFERENCES campaign_runs(id, session_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, group_id)
    REFERENCES gateway_groups(session_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS campaign_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  group_id text NOT NULL,
  message_job_id uuid UNIQUE REFERENCES message_jobs(id) ON DELETE RESTRICT,
  status campaign_delivery_status NOT NULL DEFAULT 'PENDING',
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, group_id),
  FOREIGN KEY (run_id, group_id)
    REFERENCES campaign_run_targets(run_id, group_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_campaign_deliveries_dispatch
  ON campaign_deliveries (run_id, status, created_at)
  WHERE status = 'PENDING';
