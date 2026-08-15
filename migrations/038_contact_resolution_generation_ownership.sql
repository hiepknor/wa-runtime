DELETE FROM contact_resolution_runs run
WHERE NOT EXISTS (
  SELECT 1 FROM contact_snapshot_generations generation_state
  WHERE generation_state.session_id = run.session_id
    AND generation_state.generation = run.source_generation
);

ALTER TABLE contact_resolution_runs
  DROP CONSTRAINT IF EXISTS contact_resolution_runs_source_generation_fkey;

ALTER TABLE contact_resolution_runs
  ADD CONSTRAINT contact_resolution_runs_source_generation_fkey
  FOREIGN KEY (session_id, source_generation)
  REFERENCES contact_snapshot_generations(session_id, generation) ON DELETE CASCADE;
