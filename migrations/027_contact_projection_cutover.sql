CREATE TABLE IF NOT EXISTS contact_projection_bootstrap_state (
  job_name text PRIMARY KEY,
  status text NOT NULL DEFAULT 'PENDING',
  last_session_id text,
  last_identity_id uuid,
  rows_enqueued bigint NOT NULL DEFAULT 0,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (job_name = 'MEMBER_PROJECTION_V2'),
  CHECK (status IN ('PENDING', 'COMPLETED')),
  CHECK ((last_session_id IS NULL) = (last_identity_id IS NULL)),
  CHECK (rows_enqueued >= 0)
);

INSERT INTO contact_projection_bootstrap_state (job_name)
VALUES ('MEMBER_PROJECTION_V2')
ON CONFLICT (job_name) DO NOTHING;
