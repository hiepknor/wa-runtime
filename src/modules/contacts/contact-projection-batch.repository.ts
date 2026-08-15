import { DatabaseService } from '../../core/database/database.service';
import { acquireSessionTransactionLock } from '../../core/database/session-transaction-lock';

export interface ContactProjectionClaim {
  sessionId: string;
  identityId: string;
  leaseToken: string;
}

export interface ContactProjectionBatchResult {
  updated: number;
  completed: boolean;
}

export class ContactProjectionBatchRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly mirrorLegacyProjection: boolean,
  ) {}

  async project(
    claim: ContactProjectionClaim,
    batchSize: number,
  ): Promise<ContactProjectionBatchResult> {
    return this.database.transaction(async client => {
      await acquireSessionTransactionLock(client, 'contact-member-projection', claim.sessionId);
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

      const page = await client.query<{ group_id: string; participant_id: string }>(
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
             identity.identity_type AS projected_identity_type,
             CASE
               WHEN assignment.resolution_status = 'RESOLVED' THEN assignment.resolved_phone_number
               WHEN identity.identity_type = 'PHONE_JID'
                 THEN regexp_replace(identity.identity_value, '@c\.us$', '')
               ELSE NULL
             END AS resolved_phone,
             CASE
               WHEN assignment.resolution_status = 'RESOLVED'
                 AND cluster.contact_display_name IS NOT NULL THEN cluster.contact_display_name
               WHEN member_page.participant_display_name IS NOT NULL THEN member_page.participant_display_name
               WHEN exact_push.name_value IS NOT NULL THEN exact_push.name_value
               WHEN assignment.resolution_status = 'RESOLVED'
                 AND alias_push.name_value IS NOT NULL THEN alias_push.name_value
               ELSE NULL
             END AS effective_name,
             CASE
               WHEN assignment.resolution_status = 'RESOLVED'
                 AND cluster.contact_display_name IS NOT NULL THEN 'OPENWA_CONTACT_NAME'
               WHEN member_page.participant_display_name IS NOT NULL THEN 'GROUP_PARTICIPANT_NAME'
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
             identity_type = projected.projected_identity_type,
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
               member.identity_type,
               member.shadow_resolved_phone_number, member.shadow_display_name,
               member.shadow_display_name_source, member.shadow_sort_value,
               member.shadow_projection_revision, member.shadow_resolution_run_id,
               member.resolved_phone_number, member.display_name, member.display_name_source
             ) IS DISTINCT FROM (
               projected.projected_identity_type,
               projected.resolved_phone, projected.effective_name,
               projected.effective_source,
               lower(coalesce(projected.effective_name, projected.resolved_phone,
                 projected.phone_number, projected.participant_id)),
               $3::bigint, $5::uuid,
               CASE WHEN $9::boolean THEN projected.resolved_phone ELSE member.resolved_phone_number END,
               CASE WHEN $9::boolean THEN projected.effective_name ELSE member.display_name END,
               CASE WHEN $9::boolean THEN
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
          claim.sessionId, claim.identityId, work.active_revision, work.active_cutoff_at,
          work.active_resolution_run_id, work.cursor_group_id, work.cursor_participant_id,
          batchSize, this.mirrorLegacyProjection,
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
}
