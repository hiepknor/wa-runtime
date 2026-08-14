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
  ) {}

  async enqueuePublished(limit: number): Promise<number> {
    const result = await this.database.query(
      `INSERT INTO contact_resolution_runs
         (session_id, source_generation, evidence_cutoff_at, algorithm_version)
       SELECT generation_state.session_id, generation_state.generation,
         generation_state.published_at, 1
       FROM contact_snapshot_generations generation_state
       WHERE generation_state.state = 'PUBLISHED'
         AND NOT EXISTS (
           SELECT 1 FROM contact_resolution_runs existing
           WHERE existing.session_id = generation_state.session_id
             AND existing.source_generation = generation_state.generation
             AND existing.algorithm_version = 1
         )
       ORDER BY generation_state.published_at, generation_state.session_id
       LIMIT $1
       ON CONFLICT (session_id, source_generation, algorithm_version) DO NOTHING`,
      [limit],
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
         WHERE (
           status IN ('PENDING', 'RETRY') AND next_attempt_at <= now()
         ) OR (
           status = 'RUNNING' AND lease_expires_at < now()
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
        `WITH ranked AS (
           SELECT assignment.cluster_id, observation.id, observation.name_value,
             row_number() OVER (
               PARTITION BY assignment.cluster_id
               ORDER BY observation.source_observed_at DESC,
                 observation.source_observation_key DESC, observation.id
             ) AS rank
           FROM resolved_identity_assignments assignment
           JOIN contact_observations observation
             ON observation.session_id = assignment.session_id
            AND observation.identity_id = assignment.identity_id
           WHERE assignment.session_id = $1 AND assignment.run_id = $2
             AND observation.observation_source = 'OPENWA_CONTACT_NAME'
             AND (
               observation.source_generation = $3
               OR (observation.source_generation IS NULL AND observation.created_at <= $4)
             )
         )
         UPDATE resolved_contact_clusters cluster
         SET contact_display_name = ranked.name_value,
           contact_name_observation_id = ranked.id
         FROM ranked
         WHERE cluster.session_id = $1 AND cluster.run_id = $2
           AND cluster.cluster_id = ranked.cluster_id AND ranked.rank = 1`,
        [claim.sessionId, claim.runId, generation, evidenceCutoffAt],
      );
      const result = await client.query<{
        identities: string;
        clusters: string;
        linked_identities: string;
        conflict_identities: string;
      }>(
        `WITH metrics AS (
           SELECT
             count(*)::integer AS identities,
             count(DISTINCT assignment.cluster_id)::integer AS clusters,
             count(*) FILTER (WHERE cluster.identity_count > 1)::integer AS linked_identities,
             count(*) FILTER (WHERE assignment.resolution_status = 'QUARANTINED')::integer
               AS conflict_identities
           FROM resolved_identity_assignments assignment
           JOIN resolved_contact_clusters cluster
             ON cluster.session_id = assignment.session_id AND cluster.run_id = assignment.run_id
            AND cluster.cluster_id = assignment.cluster_id
           WHERE assignment.session_id = $1 AND assignment.run_id = $2
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
             completed_at = now(), failed_at = NULL, error_code = NULL,
             lease_token = NULL, lease_expires_at = NULL, updated_at = now()
           FROM metrics
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
        const clusters = await client.query<{ cluster_id: string }>(
          `SELECT cluster_id FROM resolved_contact_clusters
           WHERE session_id = $1 AND run_id = $2 ORDER BY cluster_id`,
          [claim.sessionId, claim.runId],
        );
        await enqueueContactProjectionWork(
          client,
          claim.sessionId,
          clusters.rows.map(cluster => cluster.cluster_id),
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
