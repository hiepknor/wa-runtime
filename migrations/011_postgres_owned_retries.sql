ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS lease_token uuid;

UPDATE webhook_events
SET processing_state = 'RETRY',
    next_attempt_at = now(),
    lease_token = NULL,
    lease_expires_at = NULL,
    processing_error = 'Recovered during durable-attempt migration'
WHERE processing_state = 'PROCESSING';

ALTER TABLE sync_runs
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS lease_token uuid;

UPDATE sync_runs
SET status = 'PENDING',
    next_attempt_at = now(),
    lease_token = NULL,
    lease_expires_at = NULL,
    error = 'Recovered during durable-attempt migration',
    completed_at = NULL,
    updated_at = now()
WHERE status = 'RUNNING';

CREATE INDEX IF NOT EXISTS idx_sync_runs_dispatch
  ON sync_runs (next_attempt_at, requested_at)
  WHERE status = 'PENDING';

ALTER TABLE campaign_runs
  ADD COLUMN IF NOT EXISTS preparation_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS preparation_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS preparation_lease_token uuid,
  ADD COLUMN IF NOT EXISTS preparation_lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS preparation_error text;

CREATE INDEX IF NOT EXISTS idx_campaign_runs_preparation_dispatch
  ON campaign_runs (preparation_next_attempt_at, created_at)
  WHERE status = 'PREPARING';

ALTER TABLE gateway_groups
  ADD COLUMN IF NOT EXISTS capability_refresh_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS capability_refresh_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS capability_refresh_lease_token uuid,
  ADD COLUMN IF NOT EXISTS capability_refresh_lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS capability_refresh_error text;

CREATE INDEX IF NOT EXISTS idx_gateway_groups_capability_retry
  ON gateway_groups (capability_refresh_next_attempt_at, capability_invalidated_at, session_id, id)
  WHERE capability_invalidated_at IS NOT NULL;
