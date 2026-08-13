ALTER TABLE contact_sync_state
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

ALTER TABLE contact_sync_state
  DROP CONSTRAINT IF EXISTS contact_sync_state_attempt_count_check;

ALTER TABLE contact_sync_state
  ADD CONSTRAINT contact_sync_state_attempt_count_check CHECK (attempt_count >= 0);

CREATE INDEX IF NOT EXISTS idx_contact_sync_state_due
  ON contact_sync_state (next_attempt_at, last_completed_at)
  WHERE lease_token IS NULL;
