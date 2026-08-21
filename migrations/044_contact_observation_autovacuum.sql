SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE contact_observations SET (
  autovacuum_vacuum_threshold = 10000,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_threshold = 10000,
  autovacuum_analyze_scale_factor = 0.02
);
