ALTER TABLE contact_names
  ADD COLUMN IF NOT EXISTS source_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_observation_key text;

UPDATE contact_names
SET source_observed_at = COALESCE(source_observed_at, last_observed_at),
    source_observation_key = COALESCE(
      source_observation_key,
      'legacy:' || md5(contact_id::text || ':' || name_source)
    )
WHERE source_observed_at IS NULL OR source_observation_key IS NULL;

ALTER TABLE contact_names
  ALTER COLUMN source_observed_at SET DEFAULT now(),
  ALTER COLUMN source_observed_at SET NOT NULL,
  ALTER COLUMN source_observation_key SET DEFAULT gen_random_uuid()::text,
  ALTER COLUMN source_observation_key SET NOT NULL;

ALTER TABLE contact_names
  DROP CONSTRAINT IF EXISTS contact_names_source_observation_key_check;

ALTER TABLE contact_names
  ADD CONSTRAINT contact_names_source_observation_key_check CHECK (
    btrim(source_observation_key) <> ''
  );
