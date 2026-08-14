CREATE INDEX IF NOT EXISTS idx_group_members_unprojected_evidence
  ON group_members (session_id, evidence_identity_id)
  WHERE evidence_identity_id IS NOT NULL AND shadow_projection_revision = 0;
