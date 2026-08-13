DO $$ BEGIN
  CREATE TYPE gateway_sync_item_status AS ENUM (
    'PENDING', 'RUNNING', 'RETRY', 'COMPLETED', 'FAILED', 'SKIPPED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE sync_runs
  ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'DISCOVERING',
  ADD COLUMN IF NOT EXISTS groups_discovered integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS groups_scheduled integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS groups_failed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS groups_skipped integer NOT NULL DEFAULT 0;

UPDATE sync_runs SET phase = 'COMPLETED'
WHERE status IN ('COMPLETED', 'FAILED');

ALTER TABLE sync_runs DROP CONSTRAINT IF EXISTS sync_runs_running_epoch_required;
ALTER TABLE sync_runs
  ADD CONSTRAINT sync_runs_running_epoch_required
  CHECK (status <> 'RUNNING' OR sync_epoch IS NOT NULL);

DROP INDEX IF EXISTS idx_sync_runs_one_running_per_session;

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY session_id ORDER BY
      CASE status WHEN 'RUNNING' THEN 0 ELSE 1 END,
      requested_at, id
  ) AS active_rank
  FROM sync_runs WHERE status IN ('PENDING', 'RUNNING')
)
UPDATE sync_runs runs SET status = 'FAILED',
  error = 'Superseded while enabling one active sync per session',
  lease_token = NULL, lease_expires_at = NULL, completed_at = now(), updated_at = now()
FROM ranked WHERE runs.id = ranked.id AND ranked.active_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_runs_one_active_per_session
  ON sync_runs (session_id)
  WHERE status IN ('PENDING', 'RUNNING');

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_runs_id_session
  ON sync_runs (id, session_id);

CREATE TABLE IF NOT EXISTS gateway_sync_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid NOT NULL,
  session_id text NOT NULL,
  group_id text NOT NULL,
  ordinal integer NOT NULL,
  reason text NOT NULL,
  status gateway_sync_item_status NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  members_synced integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sync_run_id, group_id),
  FOREIGN KEY (sync_run_id, session_id)
    REFERENCES sync_runs(id, session_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, group_id)
    REFERENCES gateway_groups(session_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_gateway_sync_items_dispatch
  ON gateway_sync_items (next_attempt_at, ordinal)
  WHERE status IN ('PENDING', 'RETRY');

CREATE INDEX IF NOT EXISTS idx_gateway_sync_items_run_status
  ON gateway_sync_items (sync_run_id, status);

CREATE INDEX IF NOT EXISTS idx_gateway_sync_items_expired
  ON gateway_sync_items (lease_expires_at)
  WHERE status = 'RUNNING';

CREATE TABLE IF NOT EXISTS gateway_sync_rate_limits (
  session_id text PRIMARY KEY,
  next_request_at timestamptz NOT NULL DEFAULT now(),
  consecutive_failures integer NOT NULL DEFAULT 0,
  cooldown_until timestamptz,
  active_lease_token uuid,
  active_lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE gateway_groups
  ADD COLUMN IF NOT EXISTS summary_fingerprint text,
  ADD COLUMN IF NOT EXISTS details_fingerprint text,
  ADD COLUMN IF NOT EXISTS members_fingerprint text;
