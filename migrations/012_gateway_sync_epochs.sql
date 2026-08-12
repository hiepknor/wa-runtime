CREATE TABLE IF NOT EXISTS gateway_sync_fences (
  session_id text PRIMARY KEY,
  current_epoch bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sync_runs
  ADD COLUMN IF NOT EXISTS sync_epoch bigint;

UPDATE sync_runs
SET status = 'PENDING',
    sync_epoch = NULL,
    next_attempt_at = now(),
    lease_token = NULL,
    lease_expires_at = NULL,
    error = 'Recovered during sync-epoch migration',
    completed_at = NULL,
    updated_at = now()
WHERE status = 'RUNNING';

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_runs_one_running_per_session
  ON sync_runs (session_id)
  WHERE status = 'RUNNING';

DO $$ BEGIN
  ALTER TABLE sync_runs
    ADD CONSTRAINT sync_runs_running_epoch_required
    CHECK (status <> 'RUNNING' OR (sync_epoch IS NOT NULL AND lease_token IS NOT NULL));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
