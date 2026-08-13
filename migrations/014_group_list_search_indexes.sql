CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_gateway_groups_name_trgm
  ON gateway_groups USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_gateway_groups_id_trgm
  ON gateway_groups USING gin (id gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_gateway_groups_description_trgm
  ON gateway_groups USING gin (description gin_trgm_ops);
