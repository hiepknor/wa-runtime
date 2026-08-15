ALTER TABLE group_lists
  ADD COLUMN IF NOT EXISTS membership_revision bigint NOT NULL DEFAULT 1
    CHECK (membership_revision >= 1);

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS target_source_group_list_id uuid,
  ADD COLUMN IF NOT EXISTS target_source_group_list_name_snapshot text,
  ADD COLUMN IF NOT EXISTS target_source_membership_revision bigint,
  ADD COLUMN IF NOT EXISTS target_source_applied_at timestamptz;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_target_source_pair_check
  CHECK (
    (target_source_group_list_id IS NULL
      AND target_source_group_list_name_snapshot IS NULL
      AND target_source_membership_revision IS NULL
      AND target_source_applied_at IS NULL)
    OR
    (target_source_group_list_id IS NOT NULL
      AND target_source_group_list_name_snapshot IS NOT NULL
      AND char_length(target_source_group_list_name_snapshot) BETWEEN 1 AND 120
      AND target_source_membership_revision IS NOT NULL
      AND target_source_membership_revision >= 1
      AND target_source_applied_at IS NOT NULL)
  ),
  ADD CONSTRAINT campaigns_target_source_session_fk
  FOREIGN KEY (target_source_group_list_id, session_id)
    REFERENCES group_lists(id, session_id) ON DELETE RESTRICT;

ALTER TABLE campaign_runs
  ADD COLUMN IF NOT EXISTS target_source_group_list_id uuid,
  ADD COLUMN IF NOT EXISTS target_source_group_list_name_snapshot text,
  ADD COLUMN IF NOT EXISTS target_source_membership_revision bigint,
  ADD COLUMN IF NOT EXISTS target_source_applied_at timestamptz;

ALTER TABLE campaign_runs
  ADD CONSTRAINT campaign_runs_target_source_pair_check
  CHECK (
    (target_source_group_list_id IS NULL
      AND target_source_group_list_name_snapshot IS NULL
      AND target_source_membership_revision IS NULL
      AND target_source_applied_at IS NULL)
    OR
    (target_source_group_list_id IS NOT NULL
      AND target_source_group_list_name_snapshot IS NOT NULL
      AND char_length(target_source_group_list_name_snapshot) BETWEEN 1 AND 120
      AND target_source_membership_revision IS NOT NULL
      AND target_source_membership_revision >= 1
      AND target_source_applied_at IS NOT NULL)
  );
