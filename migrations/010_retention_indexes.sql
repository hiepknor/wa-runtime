CREATE INDEX IF NOT EXISTS idx_message_jobs_retention
  ON message_jobs (updated_at, id)
  WHERE status IN ('ACCEPTED','SENT','DELIVERED','READ','FAILED','UNKNOWN','DRY_RUN_COMPLETED','CANCELLED');

CREATE INDEX IF NOT EXISTS idx_campaign_runs_retention
  ON campaign_runs (updated_at, id)
  WHERE status IN ('COMPLETED','PARTIAL_FAILED','CANCELLED','FAILED');

CREATE INDEX IF NOT EXISTS idx_runtime_events_retention
  ON runtime_events (created_at, event_id);

CREATE INDEX IF NOT EXISTS idx_webhook_events_retention
  ON webhook_events (COALESCE(processed_at, received_at), id)
  WHERE processing_state IN ('PROCESSED','DEAD');

CREATE INDEX IF NOT EXISTS idx_sync_runs_retention
  ON sync_runs (completed_at, id)
  WHERE status IN ('COMPLETED','FAILED');
