ALTER TABLE group_members
  ADD COLUMN IF NOT EXISTS identity_type text,
  ADD COLUMN IF NOT EXISTS resolved_phone_number text;

ALTER TABLE group_members
  DROP CONSTRAINT IF EXISTS group_members_identity_type_check;

ALTER TABLE group_members
  ADD CONSTRAINT group_members_identity_type_check CHECK (
    identity_type IS NULL OR identity_type IN ('LID', 'PHONE_JID', 'OTHER_JID')
  );

ALTER TABLE group_members
  DROP CONSTRAINT IF EXISTS group_members_resolved_phone_number_check;

ALTER TABLE group_members
  ADD CONSTRAINT group_members_resolved_phone_number_check CHECK (
    resolved_phone_number IS NULL OR resolved_phone_number ~ '^[0-9]+$'
  );

CREATE TABLE IF NOT EXISTS contact_member_identity_backfill_state (
  job_name text PRIMARY KEY,
  status text NOT NULL DEFAULT 'PENDING',
  rows_processed bigint NOT NULL DEFAULT 0,
  last_session_id text,
  last_group_id text,
  last_participant_id text,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (job_name = 'MEMBER_IDENTITY_V1'),
  CHECK (status IN ('PENDING', 'RUNNING', 'RETRY', 'COMPLETED')),
  CHECK (rows_processed >= 0),
  CHECK (attempt_count >= 0),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

INSERT INTO contact_member_identity_backfill_state (job_name)
VALUES ('MEMBER_IDENTITY_V1')
ON CONFLICT (job_name) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_group_members_identity_backfill_pending
  ON group_members (session_id, group_id, participant_id)
  WHERE identity_type IS NULL;
