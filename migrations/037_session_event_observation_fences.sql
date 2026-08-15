ALTER TABLE gateway_sessions
  ADD COLUMN IF NOT EXISTS status_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS restriction_observed_at timestamptz;

UPDATE gateway_sessions
SET status_observed_at = COALESCE(status_observed_at, gateway_updated_at),
    restriction_observed_at = COALESCE(restriction_observed_at, gateway_updated_at)
WHERE status_observed_at IS NULL OR restriction_observed_at IS NULL;

ALTER TABLE gateway_sessions
  ALTER COLUMN status_observed_at SET DEFAULT '-infinity',
  ALTER COLUMN status_observed_at SET NOT NULL,
  ALTER COLUMN restriction_observed_at SET DEFAULT '-infinity',
  ALTER COLUMN restriction_observed_at SET NOT NULL;
