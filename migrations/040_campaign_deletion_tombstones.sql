ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_deleted_state_check
  CHECK (deleted_at IS NULL OR status IN ('DRAFT', 'ARCHIVED'));

CREATE INDEX IF NOT EXISTS idx_campaigns_visible_session_updated
  ON campaigns (session_id, updated_at DESC, id)
  WHERE deleted_at IS NULL;
