ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS targets_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS create_idempotency_key uuid,
  ADD COLUMN IF NOT EXISTS create_request_hash text;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_create_idempotency_pair_check
  CHECK ((create_idempotency_key IS NULL) = (create_request_hash IS NULL));

CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_create_idempotency
  ON campaigns (create_idempotency_key)
  WHERE create_idempotency_key IS NOT NULL;

ALTER TABLE campaign_runs
  ADD COLUMN IF NOT EXISTS campaign_revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS targets_revision bigint NOT NULL DEFAULT 0;

UPDATE campaign_runs
SET preflight_report = preflight_report || jsonb_build_object(
  'campaignRevision', campaign_revision,
  'targetsRevision', targets_revision
)
WHERE preflight_report IS NOT NULL
  AND (NOT (preflight_report ? 'campaignRevision') OR NOT (preflight_report ? 'targetsRevision'));
