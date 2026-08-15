CREATE INDEX IF NOT EXISTS idx_contact_observations_push_retention
  ON contact_observations (created_at, id)
  WHERE source_generation IS NULL AND observation_source = 'OPENWA_PUSH_NAME';
