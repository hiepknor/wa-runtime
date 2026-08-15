CREATE TABLE IF NOT EXISTS group_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL REFERENCES gateway_sessions(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR char_length(description) <= 500),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  create_idempotency_key uuid,
  create_request_hash text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, session_id),
  CHECK (
    (create_idempotency_key IS NULL AND create_request_hash IS NULL)
    OR (create_idempotency_key IS NOT NULL AND create_request_hash IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_group_lists_create_idempotency_key
  ON group_lists (create_idempotency_key)
  WHERE create_idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_group_lists_active_session_name
  ON group_lists (session_id, lower(name))
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_group_lists_active_session_updated
  ON group_lists (session_id, updated_at DESC, id)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS group_list_items (
  group_list_id uuid NOT NULL,
  session_id text NOT NULL,
  group_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_list_id, group_id),
  FOREIGN KEY (group_list_id, session_id)
    REFERENCES group_lists(id, session_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, group_id)
    REFERENCES gateway_groups(session_id, id) ON DELETE RESTRICT
);
