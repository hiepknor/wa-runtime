ALTER TABLE gateway_groups
  ADD COLUMN IF NOT EXISTS reconciled_summary_fingerprint text;

UPDATE gateway_groups
SET reconciled_summary_fingerprint = summary_fingerprint
WHERE details_synced_at IS NOT NULL
  AND reconciled_summary_fingerprint IS NULL;

ALTER TABLE gateway_sync_items
  ADD COLUMN IF NOT EXISTS observed_summary_fingerprint text;

ALTER TABLE gateway_sessions
  ADD COLUMN IF NOT EXISTS group_snapshot_count integer,
  ADD COLUMN IF NOT EXISTS suspicious_group_snapshot_fingerprint text,
  ADD COLUMN IF NOT EXISTS suspicious_group_snapshot_count integer,
  ADD COLUMN IF NOT EXISTS suspicious_group_snapshot_confirmations integer NOT NULL DEFAULT 0;
