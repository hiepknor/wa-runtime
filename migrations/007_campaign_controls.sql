ALTER TABLE gateway_sessions
  ADD COLUMN IF NOT EXISTS restriction jsonb;

CREATE INDEX IF NOT EXISTS idx_campaign_deliveries_message_job
  ON campaign_deliveries (message_job_id)
  WHERE message_job_id IS NOT NULL;
