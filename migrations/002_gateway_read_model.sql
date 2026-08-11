DO $$ BEGIN
  CREATE TYPE gateway_sync_status AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS gateway_sessions (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL,
  phone text,
  push_name text,
  connected_at timestamptz,
  last_active_at timestamptz,
  engine_loaded boolean NOT NULL DEFAULT false,
  last_error text,
  gateway_created_at timestamptz NOT NULL,
  gateway_updated_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gateway_groups (
  session_id text NOT NULL REFERENCES gateway_sessions(id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  description text,
  owner_id text,
  linked_parent_id text,
  participants_count integer,
  is_admin boolean,
  is_read_only boolean,
  is_announce boolean,
  settings_locked boolean,
  ephemeral_seconds integer,
  member_add_mode text,
  gateway_created_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  details_synced_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, id)
);

CREATE INDEX IF NOT EXISTS idx_gateway_groups_session_active
  ON gateway_groups (session_id, name, id)
  WHERE is_active = true;

CREATE TABLE IF NOT EXISTS group_members (
  session_id text NOT NULL,
  group_id text NOT NULL,
  participant_id text NOT NULL,
  phone_number text NOT NULL,
  display_name text,
  is_admin boolean NOT NULL DEFAULT false,
  is_super_admin boolean NOT NULL DEFAULT false,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, group_id, participant_id),
  FOREIGN KEY (session_id, group_id)
    REFERENCES gateway_groups(session_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_members_group
  ON group_members (session_id, group_id, display_name, participant_id);

CREATE TABLE IF NOT EXISTS sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  sync_type text NOT NULL,
  status gateway_sync_status NOT NULL DEFAULT 'PENDING',
  groups_synced integer NOT NULL DEFAULT 0,
  members_synced integer NOT NULL DEFAULT 0,
  error text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_session_requested
  ON sync_runs (session_id, requested_at DESC);
