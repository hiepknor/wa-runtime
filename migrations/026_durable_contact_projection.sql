CREATE SEQUENCE IF NOT EXISTS contact_projection_revision_seq AS bigint;

ALTER TABLE group_members
  ADD COLUMN IF NOT EXISTS evidence_identity_id uuid,
  ADD COLUMN IF NOT EXISTS shadow_resolved_phone_number text,
  ADD COLUMN IF NOT EXISTS shadow_display_name text,
  ADD COLUMN IF NOT EXISTS shadow_display_name_source text,
  ADD COLUMN IF NOT EXISTS shadow_sort_value text,
  ADD COLUMN IF NOT EXISTS shadow_projection_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shadow_resolution_run_id uuid;

ALTER TABLE group_members
  DROP CONSTRAINT IF EXISTS group_members_evidence_identity_fkey;

ALTER TABLE group_members
  ADD CONSTRAINT group_members_evidence_identity_fkey
  FOREIGN KEY (session_id, evidence_identity_id)
  REFERENCES observed_contact_identities(session_id, id) ON DELETE SET NULL (evidence_identity_id);

ALTER TABLE group_members
  DROP CONSTRAINT IF EXISTS group_members_shadow_resolution_run_fkey;

ALTER TABLE group_members
  ADD CONSTRAINT group_members_shadow_resolution_run_fkey
  FOREIGN KEY (session_id, shadow_resolution_run_id)
  REFERENCES contact_resolution_runs(session_id, id) ON DELETE SET NULL (shadow_resolution_run_id);

ALTER TABLE group_members
  DROP CONSTRAINT IF EXISTS group_members_shadow_phone_check;

ALTER TABLE group_members
  ADD CONSTRAINT group_members_shadow_phone_check CHECK (
    shadow_resolved_phone_number IS NULL OR shadow_resolved_phone_number ~ '^[0-9]+$'
  );

ALTER TABLE group_members
  DROP CONSTRAINT IF EXISTS group_members_shadow_name_source_check;

ALTER TABLE group_members
  ADD CONSTRAINT group_members_shadow_name_source_check CHECK (
    shadow_display_name_source IS NULL OR shadow_display_name_source IN (
      'OPENWA_CONTACT_NAME', 'GROUP_PARTICIPANT_NAME',
      'OPENWA_PUSH_NAME', 'RESOLVED_ALIAS_PUSH_NAME'
    )
  );

ALTER TABLE group_members
  DROP CONSTRAINT IF EXISTS group_members_shadow_name_consistency_check;

ALTER TABLE group_members
  ADD CONSTRAINT group_members_shadow_name_consistency_check CHECK (
    (shadow_display_name IS NULL) = (shadow_display_name_source IS NULL)
  );

ALTER TABLE group_members
  DROP CONSTRAINT IF EXISTS group_members_shadow_revision_check;

ALTER TABLE group_members
  ADD CONSTRAINT group_members_shadow_revision_check CHECK (shadow_projection_revision >= 0);

CREATE INDEX IF NOT EXISTS idx_group_members_evidence_identity
  ON group_members (session_id, evidence_identity_id, group_id, participant_id)
  WHERE evidence_identity_id IS NOT NULL;

UPDATE group_members member
SET evidence_identity_id = identity.id
FROM observed_contact_identities identity
WHERE identity.session_id = member.session_id
  AND identity.identity_type = CASE
    WHEN member.participant_id LIKE '%@lid' THEN 'LID'
    WHEN member.participant_id LIKE '%@c.us' OR member.participant_id LIKE '%@s.whatsapp.net'
      THEN 'PHONE_JID'
    ELSE 'OTHER_JID'
  END
  AND identity.identity_value = CASE
    WHEN member.participant_id LIKE '%@s.whatsapp.net'
      THEN regexp_replace(member.participant_id, '@s\.whatsapp\.net$', '@c.us')
    ELSE member.participant_id
  END
  AND member.evidence_identity_id IS NULL;

CREATE TABLE IF NOT EXISTS contact_projection_work (
  session_id text NOT NULL,
  identity_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  requested_revision bigint NOT NULL DEFAULT nextval('contact_projection_revision_seq'),
  completed_revision bigint NOT NULL DEFAULT 0,
  requested_cutoff_at timestamptz NOT NULL DEFAULT now(),
  first_requested_at timestamptz NOT NULL DEFAULT now(),
  last_requested_at timestamptz NOT NULL DEFAULT now(),
  active_revision bigint,
  active_cutoff_at timestamptz,
  active_resolution_run_id uuid,
  cursor_group_id text,
  cursor_participant_id text,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, identity_id),
  FOREIGN KEY (session_id, identity_id)
    REFERENCES observed_contact_identities(session_id, id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, active_resolution_run_id)
    REFERENCES contact_resolution_runs(session_id, id) ON DELETE SET NULL (active_resolution_run_id),
  CHECK (status IN ('IDLE', 'PENDING', 'RUNNING', 'RETRY', 'FAILED')),
  CHECK (requested_revision > 0),
  CHECK (completed_revision >= 0 AND completed_revision <= requested_revision),
  CHECK ((active_revision IS NULL) = (active_cutoff_at IS NULL)),
  CHECK ((cursor_group_id IS NULL) = (cursor_participant_id IS NULL)),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_contact_projection_work_dispatch
  ON contact_projection_work (status, next_attempt_at, first_requested_at)
  WHERE status IN ('PENDING', 'RUNNING', 'RETRY');
