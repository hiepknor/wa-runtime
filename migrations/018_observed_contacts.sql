CREATE TABLE IF NOT EXISTS contacts (
  session_id text NOT NULL REFERENCES gateway_sessions(id) ON DELETE CASCADE,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  effective_display_name text,
  display_name_source text,
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, id),
  CHECK (display_name_source IS NULL OR display_name_source IN (
    'OPENWA_CONTACT_NAME', 'GROUP_PARTICIPANT_NAME', 'OPENWA_PUSH_NAME'
  )),
  CHECK ((effective_display_name IS NULL) = (display_name_source IS NULL))
);

CREATE TABLE IF NOT EXISTS contact_identifiers (
  session_id text NOT NULL,
  contact_id uuid NOT NULL,
  identity_type text NOT NULL,
  identity_value text NOT NULL,
  mapping_source text NOT NULL,
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, identity_type, identity_value),
  FOREIGN KEY (session_id, contact_id) REFERENCES contacts(session_id, id) ON DELETE CASCADE,
  CHECK (identity_type IN ('LID', 'PHONE_JID', 'PHONE', 'OTHER_JID')),
  CHECK (mapping_source IN (
    'GROUP_PARTICIPANT', 'OPENWA_CONTACT', 'OPENWA_CONTACT_PHONE',
    'MESSAGE_IDENTITY', 'MESSAGE_ALTERNATE_IDENTITY'
  )),
  CHECK (btrim(identity_value) <> '')
);

CREATE INDEX IF NOT EXISTS idx_contact_identifiers_contact
  ON contact_identifiers (session_id, contact_id);

CREATE TABLE IF NOT EXISTS contact_names (
  session_id text NOT NULL,
  contact_id uuid NOT NULL,
  name_source text NOT NULL,
  name_value text NOT NULL,
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, contact_id, name_source),
  FOREIGN KEY (session_id, contact_id) REFERENCES contacts(session_id, id) ON DELETE CASCADE,
  CHECK (name_source IN ('OPENWA_CONTACT_NAME', 'GROUP_PARTICIPANT_NAME', 'OPENWA_PUSH_NAME')),
  CHECK (btrim(name_value) <> '')
);

CREATE INDEX IF NOT EXISTS idx_contact_names_contact
  ON contact_names (session_id, contact_id);

CREATE TABLE IF NOT EXISTS contact_sync_state (
  session_id text PRIMARY KEY REFERENCES gateway_sessions(id) ON DELETE CASCADE,
  sync_generation bigint NOT NULL DEFAULT 0,
  snapshot_completeness text NOT NULL DEFAULT 'OBSERVED',
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_successful_record_count integer,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sync_generation >= 0),
  CHECK (snapshot_completeness = 'OBSERVED'),
  CHECK (last_successful_record_count IS NULL OR last_successful_record_count >= 0)
);

ALTER TABLE group_members
  ADD COLUMN IF NOT EXISTS contact_id uuid,
  ADD COLUMN IF NOT EXISTS participant_display_name text,
  ADD COLUMN IF NOT EXISTS display_name_source text,
  ADD COLUMN IF NOT EXISTS display_name_updated_at timestamptz;

ALTER TABLE group_members
  DROP CONSTRAINT IF EXISTS group_members_display_name_source_check;

ALTER TABLE group_members
  ADD CONSTRAINT group_members_display_name_source_check CHECK (
    display_name_source IS NULL OR display_name_source IN (
      'OPENWA_CONTACT_NAME', 'GROUP_PARTICIPANT_NAME', 'OPENWA_PUSH_NAME'
    )
  );

ALTER TABLE group_members
  DROP CONSTRAINT IF EXISTS group_members_contact_id_fkey;

ALTER TABLE group_members
  ADD CONSTRAINT group_members_contact_id_fkey
  FOREIGN KEY (session_id, contact_id) REFERENCES contacts(session_id, id) ON DELETE SET NULL (contact_id);

CREATE INDEX IF NOT EXISTS idx_group_members_contact
  ON group_members (session_id, contact_id)
  WHERE contact_id IS NOT NULL;

-- Existing synchronized member identities seed the observed-contact model. The neutral phone JID
-- normalization is safe; an unresolved LID remains a LID and its numeric user-part is never stored
-- as a phone identifier.
WITH member_identities AS MATERIALIZED (
  SELECT identity.session_id, identity.identity_value, identity.identity_type, gen_random_uuid() AS contact_id
  FROM (
    SELECT DISTINCT
      session_id,
      CASE
        WHEN participant_id LIKE '%@s.whatsapp.net'
          THEN regexp_replace(participant_id, '@s\.whatsapp\.net$', '@c.us')
        ELSE participant_id
      END AS identity_value,
      CASE
        WHEN participant_id LIKE '%@lid' THEN 'LID'
        WHEN participant_id LIKE '%@c.us' OR participant_id LIKE '%@s.whatsapp.net' THEN 'PHONE_JID'
        ELSE 'OTHER_JID'
      END AS identity_type
    FROM group_members
  ) identity
), inserted_contacts AS (
  INSERT INTO contacts (session_id, id, first_observed_at, last_observed_at)
  SELECT session_id, contact_id, now(), now()
  FROM member_identities
  ON CONFLICT DO NOTHING
)
INSERT INTO contact_identifiers
  (session_id, contact_id, identity_type, identity_value, mapping_source)
SELECT session_id, contact_id, identity_type, identity_value, 'GROUP_PARTICIPANT'
FROM member_identities
ON CONFLICT (session_id, identity_type, identity_value) DO UPDATE SET
  last_observed_at = now(), updated_at = now();

-- A phone JID authoritatively carries the phone digits. LID user-parts are intentionally excluded.
INSERT INTO contact_identifiers
  (session_id, contact_id, identity_type, identity_value, mapping_source)
SELECT identifier.session_id, identifier.contact_id, 'PHONE',
  regexp_replace(identifier.identity_value, '@c\.us$', ''), 'GROUP_PARTICIPANT'
FROM contact_identifiers identifier
WHERE identifier.identity_type = 'PHONE_JID'
  AND regexp_replace(identifier.identity_value, '@c\.us$', '') ~ '^[0-9]+$'
ON CONFLICT (session_id, identity_type, identity_value) DO UPDATE SET
  last_observed_at = now(), updated_at = now();

UPDATE group_members member
SET contact_id = identifier.contact_id,
    participant_display_name = NULLIF(btrim(member.display_name), ''),
    display_name_source = CASE WHEN NULLIF(btrim(member.display_name), '') IS NULL
      THEN NULL ELSE 'GROUP_PARTICIPANT_NAME' END,
    display_name_updated_at = CASE WHEN NULLIF(btrim(member.display_name), '') IS NULL
      THEN NULL ELSE now() END
FROM contact_identifiers identifier
WHERE identifier.session_id = member.session_id
  AND identifier.identity_type = CASE
    WHEN member.participant_id LIKE '%@lid' THEN 'LID'
    WHEN member.participant_id LIKE '%@c.us' OR member.participant_id LIKE '%@s.whatsapp.net'
      THEN 'PHONE_JID'
    ELSE 'OTHER_JID'
  END
  AND identifier.identity_value = CASE
    WHEN member.participant_id LIKE '%@s.whatsapp.net'
      THEN regexp_replace(member.participant_id, '@s\.whatsapp\.net$', '@c.us')
    ELSE member.participant_id
  END;

-- Preserve one deterministic group-participant name per logical contact for the initial backfill.
WITH ranked_names AS (
  SELECT member.session_id, member.contact_id, btrim(member.participant_display_name) AS name_value,
    row_number() OVER (
      PARTITION BY member.session_id, member.contact_id
      ORDER BY member.updated_at DESC, member.group_id, member.participant_id
    ) AS rank
  FROM group_members member
  WHERE member.contact_id IS NOT NULL AND NULLIF(btrim(member.participant_display_name), '') IS NOT NULL
)
INSERT INTO contact_names
  (session_id, contact_id, name_source, name_value, first_observed_at, last_observed_at)
SELECT session_id, contact_id, 'GROUP_PARTICIPANT_NAME', name_value, now(), now()
FROM ranked_names
WHERE rank = 1
ON CONFLICT (session_id, contact_id, name_source) DO UPDATE SET
  name_value = EXCLUDED.name_value, last_observed_at = now(), updated_at = now();

UPDATE contacts contact
SET effective_display_name = source.name_value,
    display_name_source = 'GROUP_PARTICIPANT_NAME',
    updated_at = now()
FROM contact_names source
WHERE source.session_id = contact.session_id
  AND source.contact_id = contact.id
  AND source.name_source = 'GROUP_PARTICIPANT_NAME';
