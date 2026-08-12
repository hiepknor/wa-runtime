ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS processing_state text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_at timestamptz;

UPDATE webhook_events
SET processing_state = CASE WHEN processing_error IS NULL THEN 'PROCESSED' ELSE 'DEAD' END,
    dead_at = CASE WHEN processing_error IS NULL THEN NULL ELSE processed_at END
WHERE processed_at IS NOT NULL AND processing_state = 'PENDING';

ALTER TABLE webhook_events
  ADD CONSTRAINT webhook_events_processing_state_check
  CHECK (processing_state IN ('PENDING', 'PROCESSING', 'RETRY', 'PROCESSED', 'DEAD'));

CREATE INDEX IF NOT EXISTS idx_webhook_events_dispatch
  ON webhook_events (next_attempt_at, received_at)
  WHERE processing_state IN ('PENDING', 'RETRY');

CREATE INDEX IF NOT EXISTS idx_webhook_events_expired_lease
  ON webhook_events (lease_expires_at)
  WHERE processing_state = 'PROCESSING';

ALTER TABLE message_jobs
  ADD COLUMN IF NOT EXISTS idempotency_scope text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS request_hash text,
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

ALTER TABLE message_jobs
  DROP CONSTRAINT IF EXISTS message_jobs_idempotency_key_key;

UPDATE message_jobs SET idempotency_scope = 'runtime-api'
WHERE idempotency_scope = 'legacy';

UPDATE message_jobs mj
SET idempotency_scope = 'campaign-run:' || cd.run_id::text,
    idempotency_key = cd.group_id
FROM campaign_deliveries cd
WHERE cd.message_job_id = mj.id;

UPDATE message_jobs
SET request_hash = encode(digest(
  concat_ws(E'\n',
    session_id,
    recipient_id,
    payload->>'text',
    CASE
      WHEN idempotency_scope LIKE 'campaign-run:%' OR scheduled_at <= created_at + interval '1 second' THEN ''
      ELSE to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    END,
    CASE WHEN dry_run THEN 'true' ELSE 'false' END
  ),
  'sha256'
), 'hex')
WHERE request_hash IS NULL;

ALTER TABLE message_jobs
  ALTER COLUMN request_hash SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_jobs_idempotency_scope_key
  ON message_jobs (idempotency_scope, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_message_jobs_expired_processing
  ON message_jobs (lease_expires_at)
  WHERE status = 'PROCESSING';

ALTER TABLE sync_runs
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_sync_runs_expired_lease
  ON sync_runs (lease_expires_at)
  WHERE status = 'RUNNING';
