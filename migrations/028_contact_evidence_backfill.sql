CREATE TABLE IF NOT EXISTS contact_evidence_backfill_state (
  job_name text PRIMARY KEY,
  status text NOT NULL DEFAULT 'PENDING',
  last_session_id text,
  last_group_id text,
  last_participant_id text,
  rows_processed bigint NOT NULL DEFAULT 0,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (job_name = 'MEMBER_EVIDENCE_V2'),
  CHECK (status IN ('PENDING', 'COMPLETED')),
  CHECK ((last_session_id IS NULL) = (last_group_id IS NULL)),
  CHECK ((last_group_id IS NULL) = (last_participant_id IS NULL)),
  CHECK (rows_processed >= 0)
);

INSERT INTO contact_evidence_backfill_state (job_name)
VALUES ('MEMBER_EVIDENCE_V2')
ON CONFLICT (job_name) DO NOTHING;
