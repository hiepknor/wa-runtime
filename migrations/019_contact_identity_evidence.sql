CREATE TABLE IF NOT EXISTS contact_identity_evidence (
  session_id text NOT NULL REFERENCES gateway_sessions(id) ON DELETE CASCADE,
  sync_generation bigint NOT NULL,
  identity_type text NOT NULL,
  identity_value text NOT NULL,
  phone text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, sync_generation, identity_type, identity_value),
  CHECK (sync_generation > 0),
  CHECK (identity_type IN ('LID', 'PHONE_JID', 'OTHER_JID')),
  CHECK (btrim(identity_value) <> ''),
  CHECK (phone ~ '^[0-9]+$')
);

CREATE INDEX IF NOT EXISTS idx_contact_identity_evidence_phone
  ON contact_identity_evidence (session_id, sync_generation, phone);
