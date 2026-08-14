CREATE TABLE IF NOT EXISTS contact_resolution_runs (
  session_id text NOT NULL REFERENCES gateway_sessions(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source_generation bigint NOT NULL,
  evidence_cutoff_at timestamptz NOT NULL,
  algorithm_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  identity_count integer,
  cluster_count integer,
  linked_identity_count integer,
  conflict_identity_count integer,
  legacy_contact_count integer,
  legacy_linked_member_count integer,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, source_generation, algorithm_version),
  CHECK (source_generation > 0),
  CHECK (algorithm_version > 0),
  CHECK (status IN ('PENDING', 'RUNNING', 'RETRY', 'COMPLETED', 'FAILED')),
  CHECK (attempt_count >= 0),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (identity_count IS NULL OR identity_count >= 0),
  CHECK (cluster_count IS NULL OR cluster_count >= 0),
  CHECK (linked_identity_count IS NULL OR linked_identity_count >= 0),
  CHECK (conflict_identity_count IS NULL OR conflict_identity_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_contact_resolution_runs_dispatch
  ON contact_resolution_runs (status, next_attempt_at, created_at)
  WHERE status IN ('PENDING', 'RUNNING', 'RETRY');

CREATE TABLE IF NOT EXISTS resolved_contact_clusters (
  session_id text NOT NULL,
  run_id uuid NOT NULL,
  cluster_id uuid NOT NULL,
  resolved_phone_number text,
  contact_display_name text,
  contact_name_observation_id uuid,
  identity_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, run_id, cluster_id),
  FOREIGN KEY (session_id, run_id)
    REFERENCES contact_resolution_runs(session_id, id) ON DELETE CASCADE,
  CHECK (resolved_phone_number IS NULL OR resolved_phone_number ~ '^[0-9]+$'),
  CHECK ((contact_display_name IS NULL) = (contact_name_observation_id IS NULL)),
  CHECK (identity_count > 0)
);

CREATE TABLE IF NOT EXISTS resolved_identity_assignments (
  session_id text NOT NULL,
  run_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  cluster_id uuid NOT NULL,
  resolution_status text NOT NULL,
  resolved_phone_number text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, run_id, identity_id),
  FOREIGN KEY (session_id, run_id, cluster_id)
    REFERENCES resolved_contact_clusters(session_id, run_id, cluster_id) ON DELETE CASCADE,
  CHECK (resolution_status IN ('RESOLVED', 'QUARANTINED')),
  CHECK (resolved_phone_number IS NULL OR resolved_phone_number ~ '^[0-9]+$')
);

CREATE INDEX IF NOT EXISTS idx_resolved_identity_assignments_cluster
  ON resolved_identity_assignments (session_id, run_id, cluster_id);

CREATE TABLE IF NOT EXISTS contact_resolution_conflicts (
  session_id text NOT NULL,
  run_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  conflict_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, run_id, identity_id, conflict_code),
  FOREIGN KEY (session_id, run_id, identity_id)
    REFERENCES resolved_identity_assignments(session_id, run_id, identity_id) ON DELETE CASCADE,
  CHECK (conflict_code IN (
    'MULTIPLE_PHONE_TARGETS', 'PHONE_SHARED_BY_MULTIPLE_NON_PHONE_IDENTITIES'
  ))
);
