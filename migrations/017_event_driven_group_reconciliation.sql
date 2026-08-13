DO $$ BEGIN
  CREATE TYPE gateway_group_intent_status AS ENUM (
    'PENDING', 'RUNNING', 'RETRY', 'COMPLETED', 'FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS gateway_group_reconciliation_intents (
  session_id text NOT NULL REFERENCES gateway_sessions(id) ON DELETE CASCADE,
  group_id text NOT NULL,
  requested_revision bigint NOT NULL DEFAULT 1,
  completed_revision bigint NOT NULL DEFAULT 0,
  claimed_revision bigint,
  reasons text[] NOT NULL DEFAULT '{}',
  status gateway_group_intent_status NOT NULL DEFAULT 'PENDING',
  not_before timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0,
  coalesced_count bigint NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  first_requested_at timestamptz NOT NULL DEFAULT now(),
  last_requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, group_id),
  CHECK (completed_revision <= requested_revision),
  CHECK (claimed_revision IS NULL OR claimed_revision <= requested_revision)
);

CREATE INDEX IF NOT EXISTS idx_gateway_group_intents_dispatch
  ON gateway_group_reconciliation_intents (next_attempt_at, not_before, last_requested_at)
  WHERE status IN ('PENDING', 'RETRY');

CREATE INDEX IF NOT EXISTS idx_gateway_group_intents_expired
  ON gateway_group_reconciliation_intents (lease_expires_at)
  WHERE status = 'RUNNING';

ALTER TABLE gateway_sync_rate_limits
  ADD COLUMN IF NOT EXISTS effective_requests_per_minute integer,
  ADD COLUMN IF NOT EXISTS success_streak integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_rate_pressure_at timestamptz;
