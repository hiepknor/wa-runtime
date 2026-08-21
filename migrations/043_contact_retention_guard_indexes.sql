SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_contact_projection_work_active_session
  ON contact_projection_work (session_id)
  WHERE status IN ('PENDING', 'RUNNING', 'RETRY');

CREATE INDEX IF NOT EXISTS idx_resolved_contact_clusters_name_observation
  ON resolved_contact_clusters (session_id, contact_name_observation_id)
  WHERE contact_name_observation_id IS NOT NULL;
