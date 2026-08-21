import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { enqueueContactProjectionWork } from './contact-projection.enqueue';

export interface ContactResolutionClaim {
  sessionId: string;
  runId: string;
  leaseToken: string;
}

export interface ContactResolutionResult {
  identities: number;
  clusters: number;
  linkedIdentities: number;
  conflictIdentities: number;
}

@Injectable()
export class ContactResolutionRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly projectionEnabled = false,
    private readonly allowedSessionIds: string[] | null = null,
  ) {}

  async enqueuePublished(limit: number): Promise<number> {
    const result = await this.database.query(
      `INSERT INTO contact_resolution_runs
         (session_id, source_generation, evidence_cutoff_at, algorithm_version)
       SELECT generation_state.session_id, generation_state.generation,
         generation_state.published_at, 1
       FROM contact_snapshot_generations generation_state
       WHERE generation_state.state = 'PUBLISHED'
         AND ($2::text[] IS NULL OR generation_state.session_id = ANY($2::text[]))
         AND NOT EXISTS (
           SELECT 1 FROM contact_resolution_runs existing
           WHERE existing.session_id = generation_state.session_id
             AND existing.source_generation = generation_state.generation
             AND existing.algorithm_version = 1
         )
       ORDER BY generation_state.published_at, generation_state.session_id
       LIMIT $1
       ON CONFLICT (session_id, source_generation, algorithm_version) DO NOTHING`,
      [limit, this.allowedSessionIds],
    );
    return result.rowCount ?? 0;
  }

  async claim(): Promise<ContactResolutionClaim | null> {
    const result = await this.database.query<{
      session_id: string;
      id: string;
      lease_token: string;
    }>(
      `WITH candidate AS (
         SELECT session_id, id FROM contact_resolution_runs
         WHERE ($1::text[] IS NULL OR session_id = ANY($1::text[])) AND (
           (status IN ('PENDING', 'RETRY') AND next_attempt_at <= now())
           OR (status = 'RUNNING' AND lease_expires_at < now())
         )
         ORDER BY next_attempt_at, created_at, session_id
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE contact_resolution_runs run SET status = 'RUNNING',
         attempt_count = run.attempt_count + 1,
         lease_token = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes',
         started_at = COALESCE(run.started_at, now()), error_code = NULL, updated_at = now()
       FROM candidate WHERE run.session_id = candidate.session_id AND run.id = candidate.id
       RETURNING run.session_id, run.id, run.lease_token`,
      [this.allowedSessionIds],
    );
    const row = result.rows[0];
    return row ? { sessionId: row.session_id, runId: row.id, leaseToken: row.lease_token } : null;
  }

  async resolve(claim: ContactResolutionClaim): Promise<ContactResolutionResult> {
    return this.database.transaction(async client => {
      const owned = await client.query<{ source_generation: string; evidence_cutoff_at: string }>(
        `SELECT source_generation::text, evidence_cutoff_at::text FROM contact_resolution_runs
         WHERE session_id = $1 AND id = $2 AND status = 'RUNNING' AND lease_token = $3
           AND lease_expires_at > now()
         FOR UPDATE`,
        [claim.sessionId, claim.runId, claim.leaseToken],
      );
      const generation = owned.rows[0]?.source_generation;
      const evidenceCutoffAt = owned.rows[0]?.evidence_cutoff_at;
      if (!generation || !evidenceCutoffAt) throw new Error('Contact resolution lost ownership');

      await client.query(
        `DELETE FROM resolved_contact_clusters WHERE session_id = $1 AND run_id = $2`,
        [claim.sessionId, claim.runId],
      );
      await client.query(
        `CREATE TEMP TABLE resolution_edge_candidates ON COMMIT DROP AS
         SELECT evidence.left_identity_id, evidence.right_identity_id, evidence.evidence_source
         FROM contact_link_evidence evidence
         WHERE evidence.session_id = $1
           AND (
             evidence.source_generation = $2
             OR (evidence.source_generation IS NULL AND evidence.created_at <= $3)
           )`,
        [claim.sessionId, generation, evidenceCutoffAt],
      );
      await client.query(
        `CREATE TEMP TABLE resolution_conflicted_identities ON COMMIT DROP AS
         WITH multiple_targets AS (
           SELECT left_identity_id AS identity_id, 'MULTIPLE_PHONE_TARGETS'::text AS conflict_code
           FROM resolution_edge_candidates
           GROUP BY left_identity_id HAVING count(DISTINCT right_identity_id) > 1
         ), shared_phone AS (
           SELECT candidate.right_identity_id
           FROM resolution_edge_candidates candidate
           JOIN observed_contact_identities identity
             ON identity.session_id = $1 AND identity.id = candidate.left_identity_id
           WHERE candidate.evidence_source = 'OPENWA_CONTACT_PHONE'
             AND identity.identity_type <> 'PHONE_JID'
           GROUP BY candidate.right_identity_id
           HAVING count(DISTINCT candidate.left_identity_id) > 1
         ), shared_aliases AS (
           SELECT candidate.left_identity_id AS identity_id,
             'PHONE_SHARED_BY_MULTIPLE_NON_PHONE_IDENTITIES'::text AS conflict_code
           FROM resolution_edge_candidates candidate
           JOIN shared_phone ON shared_phone.right_identity_id = candidate.right_identity_id
           WHERE candidate.evidence_source = 'OPENWA_CONTACT_PHONE'
         )
         SELECT * FROM multiple_targets UNION SELECT * FROM shared_aliases`,
        [claim.sessionId],
      );
      await client.query(
        `CREATE TEMP TABLE resolution_eligible_edges ON COMMIT DROP AS
         SELECT DISTINCT candidate.left_identity_id, candidate.right_identity_id
         FROM resolution_edge_candidates candidate
         WHERE candidate.evidence_source = 'PHONE_JID_DERIVATION'
            OR NOT EXISTS (
              SELECT 1 FROM resolution_conflicted_identities conflict
              WHERE conflict.identity_id = candidate.left_identity_id
            )`,
      );
      await client.query(
        `CREATE TEMP TABLE resolution_components ON COMMIT DROP AS
         WITH RECURSIVE nodes AS (
           SELECT id FROM observed_contact_identities
           WHERE session_id = $1 AND first_observed_at <= $2
         ), undirected AS (
           SELECT left_identity_id AS source, right_identity_id AS target FROM resolution_eligible_edges
           UNION
           SELECT right_identity_id, left_identity_id FROM resolution_eligible_edges
         ), reach(root, node) AS (
           SELECT id, id FROM nodes
           UNION
           SELECT reach.root, undirected.target FROM reach
           JOIN undirected ON undirected.source = reach.node
         )
         SELECT node AS identity_id, min(root::text)::uuid AS cluster_id
         FROM reach GROUP BY node`,
        [claim.sessionId, evidenceCutoffAt],
      );
      await client.query(
        `INSERT INTO resolved_contact_clusters
           (session_id, run_id, cluster_id, resolved_phone_number, identity_count)
         SELECT $1, $2, component.cluster_id,
           CASE WHEN count(DISTINCT identity.identity_value)
             FILTER (WHERE identity.identity_type = 'PHONE') = 1
             THEN min(identity.identity_value) FILTER (WHERE identity.identity_type = 'PHONE')
             ELSE NULL END,
           count(*)
         FROM resolution_components component
         JOIN observed_contact_identities identity
           ON identity.session_id = $1 AND identity.id = component.identity_id
         GROUP BY component.cluster_id`,
        [claim.sessionId, claim.runId],
      );
      await client.query(
        `INSERT INTO resolved_identity_assignments
           (session_id, run_id, identity_id, cluster_id, resolution_status, resolved_phone_number)
         SELECT $1, $2, component.identity_id, component.cluster_id,
           CASE WHEN EXISTS (
             SELECT 1 FROM resolution_conflicted_identities conflict
             WHERE conflict.identity_id = component.identity_id
           ) THEN 'QUARANTINED' ELSE 'RESOLVED' END,
           CASE WHEN EXISTS (
             SELECT 1 FROM resolution_conflicted_identities conflict
             WHERE conflict.identity_id = component.identity_id
           ) THEN NULL ELSE cluster.resolved_phone_number END
         FROM resolution_components component
         JOIN resolved_contact_clusters cluster
           ON cluster.session_id = $1 AND cluster.run_id = $2
          AND cluster.cluster_id = component.cluster_id`,
        [claim.sessionId, claim.runId],
      );
      await client.query(
        `INSERT INTO contact_resolution_conflicts
           (session_id, run_id, identity_id, conflict_code)
         SELECT $1, $2, conflict.identity_id, conflict.conflict_code
         FROM resolution_conflicted_identities conflict
         JOIN resolved_identity_assignments assignment
           ON assignment.session_id = $1 AND assignment.run_id = $2
          AND assignment.identity_id = conflict.identity_id`,
        [claim.sessionId, claim.runId],
      );
      await client.query(
        `WITH eligible_observations AS MATERIALIZED (
           SELECT identity_id, id, name_value, source_observed_at, source_observation_key
           FROM contact_observations
           WHERE session_id = $1 AND observation_source = 'OPENWA_CONTACT_NAME'
             AND (source_generation = $3
               OR (source_generation IS NULL AND created_at <= $4))
         ), ranked AS (
           SELECT DISTINCT ON (assignment.cluster_id)
             assignment.cluster_id, observation.id, observation.name_value
           FROM eligible_observations observation
           JOIN resolved_identity_assignments assignment
             ON assignment.session_id = $1 AND assignment.run_id = $2
            AND assignment.identity_id = observation.identity_id
           ORDER BY assignment.cluster_id, observation.source_observed_at DESC,
             observation.source_observation_key DESC, observation.id
         )
         UPDATE resolved_contact_clusters cluster
         SET contact_display_name = ranked.name_value,
           contact_name_observation_id = ranked.id
         FROM ranked
         WHERE cluster.session_id = $1 AND cluster.run_id = $2
           AND cluster.cluster_id = ranked.cluster_id`,
        [claim.sessionId, claim.runId, generation, evidenceCutoffAt],
      );
      const result = await client.query<{
        identities: string;
        clusters: string;
        linked_identities: string;
        conflict_identities: string;
      }>(
        `WITH cluster_metrics AS MATERIALIZED (
           SELECT cluster_id, count(*)::integer AS identity_count
           FROM resolution_components GROUP BY cluster_id
         ), metrics AS (
           SELECT
             COALESCE(sum(identity_count), 0)::integer AS identities,
             count(*)::integer AS clusters,
             COALESCE(sum(identity_count) FILTER (WHERE identity_count > 1), 0)::integer
               AS linked_identities,
             (
               SELECT count(DISTINCT conflict.identity_id)::integer
               FROM resolution_conflicted_identities conflict
               JOIN resolution_components component
                 ON component.identity_id = conflict.identity_id
             ) AS conflict_identities
           FROM cluster_metrics
         ), completion_time AS MATERIALIZED (
           SELECT clock_timestamp() AS value
         ), completion AS (
           UPDATE contact_resolution_runs run SET status = 'COMPLETED',
             identity_count = metrics.identities, cluster_count = metrics.clusters,
             linked_identity_count = metrics.linked_identities,
             conflict_identity_count = metrics.conflict_identities,
             legacy_contact_count = (
               SELECT count(*) FROM contacts WHERE session_id = $1
             ),
             legacy_linked_member_count = (
               SELECT count(*) FROM group_members WHERE session_id = $1 AND contact_id IS NOT NULL
             ),
             completed_at = completion_time.value, failed_at = NULL, error_code = NULL,
             lease_token = NULL, lease_expires_at = NULL, updated_at = completion_time.value
           FROM metrics, completion_time
           WHERE run.session_id = $1 AND run.id = $2 AND run.lease_token = $3
           RETURNING metrics.*
         )
         SELECT identities::text, clusters::text, linked_identities::text,
           conflict_identities::text FROM completion`,
        [claim.sessionId, claim.runId, claim.leaseToken],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Contact resolution lost completion ownership');
      if (this.projectionEnabled) {
        const affected = await client.query<{ identity_id: string }>(
          `WITH previous_run AS MATERIALIZED (
             SELECT id FROM contact_resolution_runs
             WHERE session_id = $1 AND status = 'COMPLETED' AND id <> $2
             ORDER BY completed_at DESC, id DESC LIMIT 1
           ), changed_assignments AS MATERIALIZED (
             SELECT current.identity_id
             FROM resolved_identity_assignments current
             LEFT JOIN previous_run ON true
             LEFT JOIN resolved_identity_assignments previous
               ON previous.session_id = current.session_id AND previous.run_id = previous_run.id
              AND previous.identity_id = current.identity_id
             WHERE current.session_id = $1 AND current.run_id = $2
               AND (previous.identity_id IS NULL OR
                 (previous.cluster_id, previous.resolution_status, previous.resolved_phone_number)
                   IS DISTINCT FROM
                 (current.cluster_id, current.resolution_status, current.resolved_phone_number))
             UNION
             SELECT previous.identity_id
             FROM previous_run
             JOIN resolved_identity_assignments previous
               ON previous.session_id = $1 AND previous.run_id = previous_run.id
             LEFT JOIN resolved_identity_assignments current
               ON current.session_id = previous.session_id AND current.run_id = $2
              AND current.identity_id = previous.identity_id
             WHERE current.identity_id IS NULL
           ), changed_clusters AS MATERIALIZED (
             SELECT current.cluster_id
             FROM resolved_contact_clusters current
             LEFT JOIN previous_run ON true
             LEFT JOIN resolved_contact_clusters previous
               ON previous.session_id = current.session_id AND previous.run_id = previous_run.id
              AND previous.cluster_id = current.cluster_id
             WHERE current.session_id = $1 AND current.run_id = $2
               AND (previous.cluster_id IS NULL OR
                 (previous.resolved_phone_number, previous.identity_count,
                  previous.contact_display_name)
                   IS DISTINCT FROM
                 (current.resolved_phone_number, current.identity_count,
                  current.contact_display_name))
           )
           SELECT DISTINCT COALESCE(current.cluster_id, changed.identity_id) AS identity_id
           FROM changed_assignments changed
           LEFT JOIN resolved_identity_assignments current
             ON current.session_id = $1 AND current.run_id = $2
            AND current.identity_id = changed.identity_id
           UNION
           SELECT cluster_id AS identity_id FROM changed_clusters
           ORDER BY identity_id`,
          [claim.sessionId, claim.runId],
        );
        await enqueueContactProjectionWork(
          client,
          claim.sessionId,
          affected.rows.map(item => item.identity_id),
        );
      }
      return {
        identities: Number(row.identities),
        clusters: Number(row.clusters),
        linkedIdentities: Number(row.linked_identities),
        conflictIdentities: Number(row.conflict_identities),
      };
    });
  }

  async fail(claim: ContactResolutionClaim): Promise<void> {
    await this.database.query(
      `UPDATE contact_resolution_runs SET
         status = CASE WHEN attempt_count >= 5 THEN 'FAILED' ELSE 'RETRY' END,
         next_attempt_at = now() + LEAST(3600, 30 * power(2, LEAST(attempt_count, 7))) * interval '1 second',
         failed_at = CASE WHEN attempt_count >= 5 THEN now() ELSE failed_at END,
         error_code = 'RESOLUTION_ERROR', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE session_id = $1 AND id = $2 AND status = 'RUNNING' AND lease_token = $3`,
      [claim.sessionId, claim.runId, claim.leaseToken],
    );
  }
}
