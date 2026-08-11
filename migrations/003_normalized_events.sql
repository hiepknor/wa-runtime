CREATE TABLE IF NOT EXISTS runtime_events (
  event_id text PRIMARY KEY,
  source_event_type text NOT NULL,
  event_type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1,
  session_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runtime_events_session_occurred
  ON runtime_events (session_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS inbound_messages (
  session_id text NOT NULL,
  message_id text NOT NULL,
  group_id text NOT NULL,
  sender_id text NOT NULL,
  body text NOT NULL,
  message_type text NOT NULL,
  from_me boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL,
  event_id text NOT NULL UNIQUE REFERENCES runtime_events(event_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_inbound_messages_group_received
  ON inbound_messages (session_id, group_id, received_at DESC, message_id);

CREATE TABLE IF NOT EXISTS message_events (
  event_id text PRIMARY KEY REFERENCES runtime_events(event_id) ON DELETE RESTRICT,
  session_id text NOT NULL,
  message_id text NOT NULL,
  group_id text,
  event_type text NOT NULL,
  delivery_status text,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_events_message
  ON message_events (session_id, message_id, occurred_at);
