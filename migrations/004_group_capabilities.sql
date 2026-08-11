DO $$ BEGIN
  CREATE TYPE group_send_capability AS ENUM ('ALLOWED', 'DENIED', 'UNKNOWN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE gateway_groups
  ADD COLUMN IF NOT EXISTS send_capability group_send_capability NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS send_capability_reason text NOT NULL DEFAULT 'METADATA_INCOMPLETE',
  ADD COLUMN IF NOT EXISTS capability_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS capability_invalidated_at timestamptz,
  ADD COLUMN IF NOT EXISTS capability_revision integer NOT NULL DEFAULT 1;

UPDATE gateway_groups
SET
  send_capability = CASE
    WHEN is_active = false THEN 'DENIED'::group_send_capability
    WHEN details_synced_at IS NULL THEN 'UNKNOWN'::group_send_capability
    WHEN is_read_only = true THEN 'DENIED'::group_send_capability
    WHEN is_announce = true AND is_admin = false THEN 'DENIED'::group_send_capability
    WHEN is_announce = true AND is_admin IS NULL THEN 'UNKNOWN'::group_send_capability
    WHEN is_announce = false AND is_read_only = false THEN 'ALLOWED'::group_send_capability
    ELSE 'UNKNOWN'::group_send_capability
  END,
  send_capability_reason = CASE
    WHEN is_active = false THEN 'GROUP_INACTIVE'
    WHEN details_synced_at IS NULL THEN 'METADATA_INCOMPLETE'
    WHEN is_read_only = true THEN 'GROUP_READ_ONLY'
    WHEN is_announce = true AND is_admin = false THEN 'ADMIN_ONLY'
    WHEN is_announce = true AND is_admin IS NULL THEN 'ADMIN_STATUS_UNKNOWN'
    WHEN is_announce = false AND is_read_only = false THEN 'SEND_ALLOWED'
    ELSE 'METADATA_INCOMPLETE'
  END,
  capability_checked_at = details_synced_at;

CREATE INDEX IF NOT EXISTS idx_gateway_groups_capability_refresh
  ON gateway_groups (capability_invalidated_at, session_id, id)
  WHERE capability_invalidated_at IS NOT NULL;
