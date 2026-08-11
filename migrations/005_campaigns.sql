DO $$ BEGIN
  CREATE TYPE campaign_status AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE campaign_schedule_type AS ENUM ('IMMEDIATE', 'ONCE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL REFERENCES gateway_sessions(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  message_type text NOT NULL DEFAULT 'text' CHECK (message_type = 'text'),
  payload jsonb NOT NULL,
  schedule_type campaign_schedule_type NOT NULL DEFAULT 'IMMEDIATE',
  scheduled_at timestamptz,
  status campaign_status NOT NULL DEFAULT 'DRAFT',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, session_id),
  CHECK (
    (schedule_type = 'IMMEDIATE' AND scheduled_at IS NULL)
    OR (schedule_type = 'ONCE' AND scheduled_at IS NOT NULL)
  ),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (jsonb_typeof(payload->'text') = 'string'),
  CHECK (char_length(payload->>'text') BETWEEN 1 AND 4096)
);

CREATE INDEX IF NOT EXISTS idx_campaigns_session_updated
  ON campaigns (session_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS campaign_targets (
  campaign_id uuid NOT NULL,
  session_id text NOT NULL,
  group_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, group_id),
  FOREIGN KEY (campaign_id, session_id)
    REFERENCES campaigns(id, session_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, group_id)
    REFERENCES gateway_groups(session_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_campaign_targets_campaign_enabled
  ON campaign_targets (campaign_id, enabled, group_id);
