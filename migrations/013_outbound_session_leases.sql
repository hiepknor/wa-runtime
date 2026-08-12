CREATE TABLE IF NOT EXISTS outbound_session_leases (
  session_id text PRIMARY KEY,
  lease_token uuid NOT NULL,
  holder_message_job_id uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbound_session_leases_expiry
  ON outbound_session_leases (lease_expires_at);
