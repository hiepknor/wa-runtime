CREATE INDEX IF NOT EXISTS idx_group_members_missing_evidence
  ON group_members (session_id, group_id, participant_id)
  WHERE evidence_identity_id IS NULL;
