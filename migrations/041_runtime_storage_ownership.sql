CREATE INDEX IF NOT EXISTS idx_inbound_messages_retention
  ON inbound_messages (created_at, event_id);

CREATE TABLE IF NOT EXISTS contact_message_observation_intents (
  event_id text PRIMARY KEY REFERENCES runtime_events(event_id) ON DELETE CASCADE,
  session_id text NOT NULL,
  sender_id text NOT NULL,
  push_name text NOT NULL,
  observed_at timestamptz NOT NULL,
  processing_state text NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  processing_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_message_observation_intents_state_check
    CHECK (processing_state IN ('PENDING', 'PROCESSING', 'RETRY', 'DEAD'))
);

CREATE INDEX IF NOT EXISTS idx_contact_message_observation_intents_dispatch
  ON contact_message_observation_intents (next_attempt_at, created_at)
  WHERE processing_state IN ('PENDING', 'RETRY');

CREATE INDEX IF NOT EXISTS idx_contact_message_observation_intents_expired_lease
  ON contact_message_observation_intents (lease_expires_at)
  WHERE processing_state = 'PROCESSING';
