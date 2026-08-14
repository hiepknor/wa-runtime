import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { enqueueContactProjectionWork } from './contact-projection.enqueue';

export interface ContactProjectionClaim {
  sessionId: string;
  identityId: string;
  leaseToken: string;
}

export interface ContactProjectionBatchResult {
  updated: number;
  completed: boolean;
}

export interface ContactProjectionQueueMetrics {
  pending: number;
  failed: number;
  oldestLagSeconds: number;
}

@Injectable()
export class ContactProjectionRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly mirrorLegacyProjection = false,
  ) {}

  async enqueueBootstrap(limit: number): Promise<number> {
    return this.database.transaction(async client => {
      const state = await client.query<{
        last_session_id: string | null;
        last_identity_id: string | null;
      }>(
        `SELECT last_session_id, last_identity_id
         FROM contact_projection_bootstrap_state
         WHERE job_name = 'MEMBER_PROJECTION_V2' AND status = 'PENDING'
         FOR UPDATE SKIP LOCKED`,
      );
      const cursor = state.rows[0];
      if (!cursor) return 0;
      const result = await client.query<{ session_id: string; evidence_identity_id: string }>(
        `SELECT DISTINCT member.session_id, member.evidence_identity_id
         FROM group_members member
         WHERE member.evidence_identity_id IS NOT NULL
           AND ($2::text IS NULL OR (member.session_id, member.evidence_identity_id) > ($2, $3::uuid))
         ORDER BY member.session_id, member.evidence_identity_id LIMIT $1`,
        [limit, cursor.last_session_id, cursor.last_identity_id],
      );
      let enqueued = 0;
      const bySession = new Map<string, string[]>();
      for (const row of result.rows) {
        const identities = bySession.get(row.session_id) ?? [];
        identities.push(row.evidence_identity_id);
        bySession.set(row.session_id, identities);
      }
      for (const [sessionId, identities] of bySession) {
        enqueued += await enqueueContactProjectionWork(client, sessionId, identities);
      }
      const last = result.rows.at(-1);
      await client.query(
        `UPDATE contact_projection_bootstrap_state SET
           status = CASE WHEN $1::integer < $2 THEN 'COMPLETED' ELSE 'PENDING' END,
           last_session_id = COALESCE($3, last_session_id),
           last_identity_id = COALESCE($4::uuid, last_identity_id),
           rows_enqueued = rows_enqueued + $1,
           completed_at = CASE WHEN $1::integer < $2 THEN now() ELSE NULL END,
           updated_at = now()
         WHERE job_name = 'MEMBER_PROJECTION_V2'`,
        [result.rows.length, limit, last?.session_id ?? null, last?.evidence_identity_id ?? null],
      );
      return enqueued;
    });
  }

  async claim(): Promise<ContactProjectionClaim | null> {
    const result = await this.database.query<{
      session_id: string;
      identity_id: string;
      lease_token: string;
    }>(
      `WITH candidate AS (
         SELECT session_id, identity_id FROM contact_projection_work
         WHERE (
           status IN ('PENDING', 'RETRY') AND next_attempt_at <= now()
         ) OR (status = 'RUNNING' AND lease_expires_at < now())
         ORDER BY next_attempt_at, first_requested_at, session_id, identity_id
         FOR UPDATE SKIP LOCKED LIMIT 1
       ), claimed AS (
         SELECT work.*,
           COALESCE(work.active_revision, work.requested_revision) AS claim_revision,
           COALESCE(work.active_cutoff_at, work.requested_cutoff_at) AS claim_cutoff
         FROM contact_projection_work work JOIN candidate USING (session_id, identity_id)
       )
       UPDATE contact_projection_work work SET status = 'RUNNING',
         active_revision = claimed.claim_revision,
         active_cutoff_at = claimed.claim_cutoff,
         active_resolution_run_id = COALESCE(work.active_resolution_run_id, (
           SELECT run.id FROM contact_resolution_runs run
           WHERE run.session_id = work.session_id AND run.status = 'COMPLETED'
             AND run.completed_at <= claimed.claim_cutoff
           ORDER BY run.completed_at DESC, run.id DESC LIMIT 1
         )),
         attempt_count = work.attempt_count + 1,
         lease_token = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes',
         error_code = NULL, updated_at = now()
       FROM claimed
       WHERE work.session_id = claimed.session_id AND work.identity_id = claimed.identity_id
       RETURNING work.session_id, work.identity_id, work.lease_token`,
    );
    const row = result.rows[0];
    return row ? {
      sessionId: row.session_id,
      identityId: row.identity_id,
      leaseToken: row.lease_token,
    } : null;
  }

  async getQueueMetrics(): Promise<ContactProjectionQueueMetrics> {
    const result = await this.database.query<{
      pending: string;
      failed: string;
      oldest_lag_seconds: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE status IN ('PENDING', 'RUNNING', 'RETRY'))::text AS pending,
         count(*) FILTER (WHERE status = 'FAILED')::text AS failed,
         COALESCE(max(extract(epoch FROM now() - first_requested_at))
           FILTER (WHERE status IN ('PENDING', 'RUNNING', 'RETRY')), 0)::text AS oldest_lag_seconds
       FROM contact_projection_work`,
    );
    const row = result.rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      failed: Number(row?.failed ?? 0),
      oldestLagSeconds: Number(row?.oldest_lag_seconds ?? 0),
    };
  }

  async projectBatch(
    claim: ContactProjectionClaim,
    batchSize: number,
  ): Promise<ContactProjectionBatchResult> {
    return this.database.transaction(async client => {
      const owned = await client.query<{
        active_revision: string;
        active_cutoff_at: string;
        active_resolution_run_id: string | null;
        cursor_group_id: string | null;
        cursor_participant_id: string | null;
      }>(
        `SELECT active_revision::text, active_cutoff_at::text, active_resolution_run_id,
           cursor_group_id, cursor_participant_id
         FROM contact_projection_work
         WHERE session_id = $1 AND identity_id = $2 AND status = 'RUNNING'
           AND lease_token = $3 AND lease_expires_at > now()
         FOR UPDATE`,
        [claim.sessionId, claim.identityId, claim.leaseToken],
      );
      const work = owned.rows[0];
      if (!work) throw new Error('Contact projection lost ownership');

      const page = await client.query<{
        group_id: string;
        participant_id: string;
      }>(
        `WITH affected_identities AS MATERIALIZED (
           SELECT $2::uuid AS identity_id
           UNION
           SELECT alias.identity_id
           FROM resolved_identity_assignments root
           JOIN resolved_identity_assignments alias
             ON alias.session_id = root.session_id AND alias.run_id = root.run_id
            AND alias.cluster_id = root.cluster_id AND alias.resolution_status = 'RESOLVED'
           WHERE root.session_id = $1 AND root.run_id = $5::uuid
             AND root.identity_id = $2 AND root.resolution_status = 'RESOLVED'
         ), member_page AS MATERIALIZED (
           SELECT member.session_id, member.group_id, member.participant_id,
             member.evidence_identity_id, member.participant_display_name,
             member.phone_number
           FROM group_members member
           JOIN affected_identities affected ON affected.identity_id = member.evidence_identity_id
           WHERE member.session_id = $1
             AND ($6::text IS NULL OR (member.group_id, member.participant_id) > ($6, $7))
           ORDER BY member.group_id, member.participant_id LIMIT $8
         ), projected AS MATERIALIZED (
           SELECT member_page.*,
             CASE
               WHEN assignment.resolution_status = 'RESOLVED'
                 THEN assignment.resolved_phone_number
               WHEN identity.identity_type = 'PHONE_JID'
                 THEN regexp_replace(identity.identity_value, '@c\.us$', '')
               ELSE NULL
             END AS resolved_phone,
             CASE
               WHEN assignment.resolution_status = 'RESOLVED'
                 AND cluster.contact_display_name IS NOT NULL
                 THEN cluster.contact_display_name
               WHEN member_page.participant_display_name IS NOT NULL
                 THEN member_page.participant_display_name
               WHEN exact_push.name_value IS NOT NULL THEN exact_push.name_value
               WHEN assignment.resolution_status = 'RESOLVED'
                 AND alias_push.name_value IS NOT NULL THEN alias_push.name_value
               ELSE NULL
             END AS effective_name,
             CASE
               WHEN assignment.resolution_status = 'RESOLVED'
                 AND cluster.contact_display_name IS NOT NULL
                 THEN 'OPENWA_CONTACT_NAME'
               WHEN member_page.participant_display_name IS NOT NULL
                 THEN 'GROUP_PARTICIPANT_NAME'
               WHEN exact_push.name_value IS NOT NULL THEN 'OPENWA_PUSH_NAME'
               WHEN assignment.resolution_status = 'RESOLVED'
                 AND alias_push.name_value IS NOT NULL THEN 'RESOLVED_ALIAS_PUSH_NAME'
               ELSE NULL
             END AS effective_source
           FROM member_page
           JOIN observed_contact_identities identity
             ON identity.session_id = member_page.session_id
            AND identity.id = member_page.evidence_identity_id
           LEFT JOIN resolved_identity_assignments assignment
             ON assignment.session_id = member_page.session_id
            AND assignment.run_id = $5::uuid
            AND assignment.identity_id = member_page.evidence_identity_id
           LEFT JOIN resolved_contact_clusters cluster
             ON cluster.session_id = assignment.session_id AND cluster.run_id = assignment.run_id
            AND cluster.cluster_id = assignment.cluster_id
           LEFT JOIN LATERAL (
             SELECT observation.name_value FROM contact_observations observation
             WHERE observation.session_id = member_page.session_id
               AND observation.identity_id = member_page.evidence_identity_id
               AND observation.observation_source = 'OPENWA_PUSH_NAME'
               AND observation.created_at <= $4
             ORDER BY observation.source_observed_at DESC,
               observation.source_observation_key DESC, observation.id DESC LIMIT 1
           ) exact_push ON true
           LEFT JOIN LATERAL (
             SELECT observation.name_value
             FROM resolved_identity_assignments alias_assignment
             JOIN contact_observations observation
               ON observation.session_id = alias_assignment.session_id
              AND observation.identity_id = alias_assignment.identity_id
             WHERE alias_assignment.session_id = assignment.session_id
               AND alias_assignment.run_id = assignment.run_id
               AND alias_assignment.cluster_id = assignment.cluster_id
               AND alias_assignment.resolution_status = 'RESOLVED'
               AND alias_assignment.identity_id <> member_page.evidence_identity_id
               AND observation.observation_source = 'OPENWA_PUSH_NAME'
               AND observation.created_at <= $4
             ORDER BY observation.source_observed_at DESC,
               observation.source_observation_key DESC, observation.id DESC LIMIT 1
           ) alias_push ON true
         ), writes AS (
           UPDATE group_members member SET
             shadow_resolved_phone_number = projected.resolved_phone,
             shadow_display_name = projected.effective_name,
             shadow_display_name_source = projected.effective_source,
             shadow_sort_value = lower(coalesce(
               projected.effective_name, projected.resolved_phone,
               projected.phone_number, projected.participant_id
             )),
             shadow_projection_revision = $3,
             shadow_resolution_run_id = $5::uuid,
             resolved_phone_number = CASE WHEN $9::boolean
               THEN projected.resolved_phone ELSE member.resolved_phone_number END,
             display_name = CASE WHEN $9::boolean
               THEN projected.effective_name ELSE member.display_name END,
             display_name_source = CASE WHEN $9::boolean THEN
               CASE WHEN projected.effective_source = 'RESOLVED_ALIAS_PUSH_NAME'
                 THEN 'OPENWA_PUSH_NAME' ELSE projected.effective_source END
               ELSE member.display_name_source END,
             display_name_updated_at = CASE WHEN NOT $9::boolean THEN member.display_name_updated_at
               WHEN projected.effective_name IS NULL THEN NULL ELSE now() END,
             updated_at = CASE WHEN (
               member.shadow_resolved_phone_number, member.shadow_display_name,
               member.shadow_display_name_source, member.shadow_sort_value,
               member.shadow_projection_revision, member.shadow_resolution_run_id
               , member.resolved_phone_number, member.display_name, member.display_name_source
             ) IS DISTINCT FROM (
               projected.resolved_phone, projected.effective_name,
               projected.effective_source,
               lower(coalesce(projected.effective_name, projected.resolved_phone,
                 projected.phone_number, projected.participant_id)),
               $3::bigint, $5::uuid
               , CASE WHEN $9::boolean THEN projected.resolved_phone ELSE member.resolved_phone_number END
               , CASE WHEN $9::boolean THEN projected.effective_name ELSE member.display_name END
               , CASE WHEN $9::boolean THEN
                   CASE WHEN projected.effective_source = 'RESOLVED_ALIAS_PUSH_NAME'
                     THEN 'OPENWA_PUSH_NAME' ELSE projected.effective_source END
                 ELSE member.display_name_source END
             ) THEN now() ELSE member.updated_at END
           FROM projected
           WHERE member.session_id = projected.session_id
             AND member.group_id = projected.group_id
             AND member.participant_id = projected.participant_id
             AND member.shadow_projection_revision <= $3
         )
         SELECT group_id, participant_id FROM member_page
         ORDER BY group_id, participant_id`,
        [
          claim.sessionId,
          claim.identityId,
          work.active_revision,
          work.active_cutoff_at,
          work.active_resolution_run_id,
          work.cursor_group_id,
          work.cursor_participant_id,
          batchSize,
          this.mirrorLegacyProjection,
        ],
      );
      const last = page.rows.at(-1);
      const completed = page.rows.length < batchSize;
      if (completed) {
        await client.query(
          `UPDATE contact_projection_work SET
             completed_revision = active_revision,
             status = CASE WHEN requested_revision > active_revision THEN 'PENDING' ELSE 'IDLE' END,
             first_requested_at = CASE WHEN requested_revision > active_revision
               THEN last_requested_at ELSE first_requested_at END,
             active_revision = NULL, active_cutoff_at = NULL, active_resolution_run_id = NULL,
             cursor_group_id = NULL, cursor_participant_id = NULL,
             attempt_count = 0, next_attempt_at = now(), lease_token = NULL,
             lease_expires_at = NULL, completed_at = now(), failed_at = NULL,
             error_code = NULL, updated_at = now()
           WHERE session_id = $1 AND identity_id = $2 AND lease_token = $3`,
          [claim.sessionId, claim.identityId, claim.leaseToken],
        );
      } else {
        await client.query(
          `UPDATE contact_projection_work SET cursor_group_id = $4,
             cursor_participant_id = $5,
             lease_expires_at = now() + interval '5 minutes', updated_at = now()
           WHERE session_id = $1 AND identity_id = $2 AND lease_token = $3`,
          [claim.sessionId, claim.identityId, claim.leaseToken, last!.group_id, last!.participant_id],
        );
      }
      return { updated: page.rows.length, completed };
    });
  }

  async release(claim: ContactProjectionClaim): Promise<void> {
    await this.database.query(
      `UPDATE contact_projection_work SET status = 'PENDING', next_attempt_at = now(),
         lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE session_id = $1 AND identity_id = $2 AND status = 'RUNNING' AND lease_token = $3`,
      [claim.sessionId, claim.identityId, claim.leaseToken],
    );
  }

  async fail(claim: ContactProjectionClaim): Promise<void> {
    await this.database.query(
      `UPDATE contact_projection_work SET
         status = CASE WHEN attempt_count >= 5 THEN 'FAILED' ELSE 'RETRY' END,
         next_attempt_at = now() + LEAST(3600, 30 * power(2, LEAST(attempt_count, 7))) * interval '1 second',
         failed_at = CASE WHEN attempt_count >= 5 THEN now() ELSE failed_at END,
         error_code = 'PROJECTION_ERROR', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE session_id = $1 AND identity_id = $2 AND status = 'RUNNING' AND lease_token = $3`,
      [claim.sessionId, claim.identityId, claim.leaseToken],
    );
  }
}
