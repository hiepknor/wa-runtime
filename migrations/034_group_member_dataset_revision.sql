ALTER TABLE gateway_groups
  ADD COLUMN IF NOT EXISTS member_dataset_revision bigint NOT NULL DEFAULT 0
    CHECK (member_dataset_revision >= 0);

CREATE OR REPLACE FUNCTION bump_group_member_dataset_revision_from_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE gateway_groups groups
  SET member_dataset_revision = groups.member_dataset_revision + 1
  FROM (SELECT DISTINCT session_id, group_id FROM new_member_rows) changed
  WHERE groups.session_id = changed.session_id AND groups.id = changed.group_id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION bump_group_member_dataset_revision_from_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE gateway_groups groups
  SET member_dataset_revision = groups.member_dataset_revision + 1
  FROM (
    SELECT session_id, group_id FROM new_member_rows
    UNION
    SELECT session_id, group_id FROM old_member_rows
  ) changed
  WHERE groups.session_id = changed.session_id AND groups.id = changed.group_id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION bump_group_member_dataset_revision_from_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE gateway_groups groups
  SET member_dataset_revision = groups.member_dataset_revision + 1
  FROM (SELECT DISTINCT session_id, group_id FROM old_member_rows) changed
  WHERE groups.session_id = changed.session_id AND groups.id = changed.group_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_group_members_dataset_revision_insert ON group_members;
CREATE TRIGGER trg_group_members_dataset_revision_insert
AFTER INSERT ON group_members
REFERENCING NEW TABLE AS new_member_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_group_member_dataset_revision_from_insert();

DROP TRIGGER IF EXISTS trg_group_members_dataset_revision_update ON group_members;
CREATE TRIGGER trg_group_members_dataset_revision_update
AFTER UPDATE ON group_members
REFERENCING OLD TABLE AS old_member_rows NEW TABLE AS new_member_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_group_member_dataset_revision_from_update();

DROP TRIGGER IF EXISTS trg_group_members_dataset_revision_delete ON group_members;
CREATE TRIGGER trg_group_members_dataset_revision_delete
AFTER DELETE ON group_members
REFERENCING OLD TABLE AS old_member_rows
FOR EACH STATEMENT EXECUTE FUNCTION bump_group_member_dataset_revision_from_delete();
