CREATE TABLE IF NOT EXISTS observed_contact_identities (
  session_id text NOT NULL REFERENCES gateway_sessions(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  identity_type text NOT NULL,
  identity_value text NOT NULL,
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, identity_type, identity_value),
  CHECK (identity_type IN ('LID', 'PHONE_JID', 'PHONE', 'OTHER_JID')),
  CHECK (btrim(identity_value) <> '')
);

CREATE TABLE IF NOT EXISTS contact_observations (
  session_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL,
  observation_source text NOT NULL,
  observation_scope text NOT NULL,
  group_id text,
  participant_id text,
  name_value text NOT NULL,
  source_generation bigint,
  source_observed_at timestamptz NOT NULL,
  source_observation_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, observation_source, source_observation_key),
  FOREIGN KEY (session_id, identity_id)
    REFERENCES observed_contact_identities(session_id, id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, source_generation)
    REFERENCES contact_snapshot_generations(session_id, generation) ON DELETE CASCADE,
  CHECK (observation_source IN (
    'OPENWA_CONTACT_NAME', 'GROUP_PARTICIPANT_NAME', 'OPENWA_PUSH_NAME'
  )),
  CHECK (observation_scope IN ('IDENTITY', 'MEMBERSHIP')),
  CHECK (
    (observation_scope = 'IDENTITY' AND group_id IS NULL AND participant_id IS NULL)
    OR (observation_scope = 'MEMBERSHIP'
      AND group_id IS NOT NULL AND participant_id IS NOT NULL
      AND btrim(group_id) <> '' AND btrim(participant_id) <> '')
  ),
  CHECK (btrim(name_value) <> ''),
  CHECK (char_length(name_value) <= 256),
  CHECK (name_value !~ '[[:cntrl:]]'),
  CHECK (btrim(source_observation_key) <> '')
);

CREATE INDEX IF NOT EXISTS idx_contact_observations_identity
  ON contact_observations (session_id, identity_id, observation_source, source_observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_observations_generation
  ON contact_observations (session_id, source_generation)
  WHERE source_generation IS NOT NULL;

CREATE TABLE IF NOT EXISTS contact_link_evidence (
  session_id text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  left_identity_id uuid NOT NULL,
  right_identity_id uuid NOT NULL,
  evidence_source text NOT NULL,
  source_generation bigint,
  source_observed_at timestamptz NOT NULL,
  source_observation_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, evidence_source, source_observation_key),
  FOREIGN KEY (session_id, left_identity_id)
    REFERENCES observed_contact_identities(session_id, id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, right_identity_id)
    REFERENCES observed_contact_identities(session_id, id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, source_generation)
    REFERENCES contact_snapshot_generations(session_id, generation) ON DELETE CASCADE,
  CHECK (left_identity_id <> right_identity_id),
  CHECK (evidence_source IN ('PHONE_JID_DERIVATION', 'OPENWA_CONTACT_PHONE')),
  CHECK (btrim(source_observation_key) <> '')
);

CREATE INDEX IF NOT EXISTS idx_contact_link_evidence_left
  ON contact_link_evidence (session_id, left_identity_id, source_observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_link_evidence_right
  ON contact_link_evidence (session_id, right_identity_id, source_observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_link_evidence_generation
  ON contact_link_evidence (session_id, source_generation)
  WHERE source_generation IS NOT NULL;
