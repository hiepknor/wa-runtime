import type { PoolClient } from 'pg';

export async function enqueueContactProjectionWork(
  client: PoolClient,
  sessionId: string,
  identityIds: string[],
): Promise<number> {
  if (identityIds.length === 0) return 0;
  const result = await client.query<{ enqueued: string }>(
    `WITH request_time AS MATERIALIZED (
       SELECT statement_timestamp() AS value
     ), latest_run AS MATERIALIZED (
       SELECT id FROM contact_resolution_runs
       WHERE session_id = $1 AND status = 'COMPLETED'
       ORDER BY completed_at DESC, id DESC LIMIT 1
     ), requested AS MATERIALIZED (
       SELECT DISTINCT identity.id AS source_identity_id, CASE
         WHEN assignment.resolution_status = 'RESOLVED' THEN assignment.cluster_id
         ELSE identity.id
       END AS projection_identity_id
       FROM unnest($2::uuid[]) requested(identity_id)
       JOIN observed_contact_identities identity
         ON identity.session_id = $1 AND identity.id = requested.identity_id
       LEFT JOIN latest_run ON true
       LEFT JOIN resolved_identity_assignments assignment
         ON assignment.session_id = $1 AND assignment.run_id = latest_run.id
        AND assignment.identity_id = identity.id
     ), canonical AS MATERIALIZED (
       SELECT DISTINCT projection_identity_id FROM requested
     ), upserted AS (
     INSERT INTO contact_projection_work
       (session_id, identity_id, requested_revision, requested_cutoff_at,
        first_requested_at, last_requested_at)
     SELECT $1, canonical.projection_identity_id,
       nextval('contact_projection_revision_seq'),
       request_time.value, request_time.value, request_time.value
     FROM canonical CROSS JOIN request_time
     ON CONFLICT (session_id, identity_id) DO UPDATE SET
       requested_revision = EXCLUDED.requested_revision,
       requested_cutoff_at = EXCLUDED.requested_cutoff_at,
       first_requested_at = CASE
         WHEN contact_projection_work.status IN ('IDLE', 'FAILED')
           THEN EXCLUDED.first_requested_at
         ELSE contact_projection_work.first_requested_at
       END,
       last_requested_at = EXCLUDED.last_requested_at,
       status = CASE
         WHEN contact_projection_work.status IN ('RUNNING', 'RETRY')
           AND contact_projection_work.active_revision IS NOT NULL
         THEN contact_projection_work.status
         ELSE 'PENDING'
       END,
       active_revision = CASE
         WHEN contact_projection_work.status IN ('RUNNING', 'RETRY')
           AND contact_projection_work.active_revision IS NOT NULL
         THEN contact_projection_work.active_revision ELSE NULL
       END,
       active_cutoff_at = CASE
         WHEN contact_projection_work.status IN ('RUNNING', 'RETRY')
           AND contact_projection_work.active_revision IS NOT NULL
         THEN contact_projection_work.active_cutoff_at ELSE NULL
       END,
       active_resolution_run_id = CASE
         WHEN contact_projection_work.status IN ('RUNNING', 'RETRY')
           AND contact_projection_work.active_revision IS NOT NULL
         THEN contact_projection_work.active_resolution_run_id ELSE NULL
       END,
       cursor_group_id = CASE
         WHEN contact_projection_work.status IN ('RUNNING', 'RETRY')
           AND contact_projection_work.active_revision IS NOT NULL
         THEN contact_projection_work.cursor_group_id ELSE NULL
       END,
       cursor_participant_id = CASE
         WHEN contact_projection_work.status IN ('RUNNING', 'RETRY')
           AND contact_projection_work.active_revision IS NOT NULL
         THEN contact_projection_work.cursor_participant_id ELSE NULL
       END,
       attempt_count = CASE
         WHEN contact_projection_work.status IN ('RUNNING', 'RETRY')
           AND contact_projection_work.active_revision IS NOT NULL
         THEN contact_projection_work.attempt_count ELSE 0
       END,
       next_attempt_at = EXCLUDED.last_requested_at,
       failed_at = NULL, error_code = NULL, updated_at = EXCLUDED.last_requested_at
     RETURNING identity_id
     ), retired_aliases AS (
       UPDATE contact_projection_work work SET status = 'IDLE',
         active_revision = NULL, active_cutoff_at = NULL, active_resolution_run_id = NULL,
         cursor_group_id = NULL, cursor_participant_id = NULL,
         lease_token = NULL, lease_expires_at = NULL, failed_at = NULL, error_code = NULL,
         updated_at = request_time.value
       FROM requested CROSS JOIN request_time
       WHERE work.session_id = $1 AND work.identity_id = requested.source_identity_id
         AND requested.source_identity_id <> requested.projection_identity_id
         AND work.status IN ('PENDING', 'RETRY', 'FAILED')
       RETURNING work.identity_id
     )
     SELECT count(*)::text AS enqueued FROM upserted`,
    [sessionId, identityIds],
  );
  return Number(result.rows[0]?.enqueued ?? 0);
}
