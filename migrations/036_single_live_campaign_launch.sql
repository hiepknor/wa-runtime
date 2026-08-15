CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_runs_single_live_launch
  ON campaign_runs (campaign_id)
  WHERE execution_mode = 'LIVE';
