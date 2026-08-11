ALTER TABLE campaign_runs
  ADD COLUMN IF NOT EXISTS status_reason text;
