CREATE INDEX IF NOT EXISTS idx_group_members_missing_identity_type
  ON group_members (session_id, evidence_identity_id)
  WHERE evidence_identity_id IS NOT NULL AND identity_type IS NULL;
