CREATE TABLE IF NOT EXISTS contact_snapshot_generations (
  session_id text NOT NULL REFERENCES gateway_sessions(id) ON DELETE CASCADE,
  generation bigint NOT NULL,
  state text NOT NULL DEFAULT 'RECEIVING',
  lease_token uuid NOT NULL,
  upstream_record_count integer,
  staged_identity_count integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  failed_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, generation),
  CHECK (generation > 0),
  CHECK (state IN ('RECEIVING', 'PUBLISHED', 'FAILED')),
  CHECK (upstream_record_count IS NULL OR upstream_record_count >= 0),
  CHECK (staged_identity_count >= 0),
  CHECK (
    (state = 'RECEIVING' AND published_at IS NULL AND failed_at IS NULL AND error_code IS NULL)
    OR (state = 'PUBLISHED' AND published_at IS NOT NULL AND failed_at IS NULL AND error_code IS NULL)
    OR (state = 'FAILED' AND published_at IS NULL AND failed_at IS NOT NULL AND error_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_contact_snapshot_generations_published
  ON contact_snapshot_generations (session_id, generation DESC)
  WHERE state = 'PUBLISHED';

CREATE TABLE IF NOT EXISTS contact_snapshot_observations (
  session_id text NOT NULL,
  generation bigint NOT NULL,
  identity_type text NOT NULL,
  identity_value text NOT NULL,
  phone text,
  contact_name text,
  push_name text,
  source_observed_at timestamptz NOT NULL DEFAULT now(),
  source_observation_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, generation, identity_type, identity_value),
  FOREIGN KEY (session_id, generation)
    REFERENCES contact_snapshot_generations(session_id, generation) ON DELETE CASCADE,
  CHECK (identity_type IN ('LID', 'PHONE_JID', 'OTHER_JID')),
  CHECK (btrim(identity_value) <> ''),
  CHECK (phone IS NULL OR phone ~ '^[0-9]+$'),
  CHECK (contact_name IS NULL OR btrim(contact_name) <> ''),
  CHECK (push_name IS NULL OR btrim(push_name) <> ''),
  CHECK (btrim(source_observation_key) <> '')
);
