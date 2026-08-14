import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';

const JOB_NAME = 'MEMBER_IDENTITY_V1';

export interface MemberIdentityBackfillBatchResult {
  updated: number;
  completed: boolean;
  lostOwnership: boolean;
}

@Injectable()
export class ContactMemberIdentityBackfillRepository {
  constructor(private readonly database: DatabaseService) {}

  async claim(): Promise<string | null> {
    const result = await this.database.query<{ lease_token: string }>(
      `UPDATE contact_member_identity_backfill_state state SET
         status = 'RUNNING', attempt_count = CASE
           WHEN state.status IN ('RETRY', 'RUNNING') THEN state.attempt_count + 1
           ELSE state.attempt_count
         END,
         lease_token = gen_random_uuid(), lease_expires_at = now() + interval '2 minutes',
         started_at = COALESCE(state.started_at, now()), completed_at = NULL,
         last_error_code = NULL, updated_at = now()
       WHERE state.job_name = $1 AND state.next_attempt_at <= now()
         AND (
           state.status IN ('PENDING', 'RETRY')
           OR (state.status = 'RUNNING' AND state.lease_expires_at < now())
           OR (state.status = 'COMPLETED' AND EXISTS (
             SELECT 1 FROM group_members member WHERE member.identity_type IS NULL
           ))
         )
       RETURNING lease_token`,
      [JOB_NAME],
    );
    return result.rows[0]?.lease_token ?? null;
  }

  async processBatch(leaseToken: string, batchSize: number): Promise<MemberIdentityBackfillBatchResult> {
    return this.database.transaction(async client => {
      const owned = await client.query(
        `SELECT 1 FROM contact_member_identity_backfill_state
         WHERE job_name = $1 AND status = 'RUNNING' AND lease_token = $2
           AND lease_expires_at > now() FOR UPDATE`,
        [JOB_NAME, leaseToken],
      );
      if (owned.rowCount !== 1) return { updated: 0, completed: false, lostOwnership: true };

      const result = await client.query<{
        updated: string;
        last_session_id: string | null;
        last_group_id: string | null;
        last_participant_id: string | null;
      }>(
        `WITH candidates AS MATERIALIZED (
           SELECT session_id, group_id, participant_id
           FROM group_members
           WHERE identity_type IS NULL
           ORDER BY session_id, group_id, participant_id
           LIMIT $1 FOR UPDATE SKIP LOCKED
         ), normalized AS MATERIALIZED (
           SELECT candidates.*,
             regexp_replace(candidates.participant_id, ':\\d+(?=@)', '') AS normalized_id
           FROM candidates
         ), projected AS MATERIALIZED (
           SELECT normalized.*,
             CASE
               WHEN normalized_id LIKE '%@lid' THEN 'LID'
               WHEN normalized_id LIKE '%@c.us' OR normalized_id LIKE '%@s.whatsapp.net'
                 THEN 'PHONE_JID'
               ELSE 'OTHER_JID'
             END AS identity_type,
             regexp_replace(normalized_id, '@(c\\.us|s\\.whatsapp\\.net)$', '') AS phone_candidate
           FROM normalized
         ), updated AS (
           UPDATE group_members member SET
             identity_type = projected.identity_type,
             resolved_phone_number = CASE
               WHEN projected.identity_type = 'PHONE_JID' AND projected.phone_candidate ~ '^[0-9]+$'
                 THEN projected.phone_candidate
               ELSE NULL
             END,
             updated_at = now()
           FROM projected
           WHERE member.session_id = projected.session_id
             AND member.group_id = projected.group_id
             AND member.participant_id = projected.participant_id
             AND member.identity_type IS NULL
           RETURNING member.session_id, member.group_id, member.participant_id
         )
         SELECT count(*)::text AS updated,
           (array_agg(session_id ORDER BY session_id DESC, group_id DESC, participant_id DESC))[1]
             AS last_session_id,
           (array_agg(group_id ORDER BY session_id DESC, group_id DESC, participant_id DESC))[1]
             AS last_group_id,
           (array_agg(participant_id ORDER BY session_id DESC, group_id DESC, participant_id DESC))[1]
             AS last_participant_id
         FROM updated`,
        [batchSize],
      );
      const row = result.rows[0];
      const updated = Number(row?.updated ?? 0);
      const remaining = await client.query(
        'SELECT 1 FROM group_members WHERE identity_type IS NULL LIMIT 1',
      );
      const completed = remaining.rowCount === 0;
      const state = await client.query(
        `UPDATE contact_member_identity_backfill_state SET
           status = CASE WHEN $3 THEN 'COMPLETED' ELSE 'RUNNING' END,
           rows_processed = rows_processed + $4,
           last_session_id = COALESCE($5, last_session_id),
           last_group_id = COALESCE($6, last_group_id),
           last_participant_id = COALESCE($7, last_participant_id),
           attempt_count = CASE WHEN $3 THEN 0 ELSE attempt_count END,
           completed_at = CASE WHEN $3 THEN now() ELSE NULL END,
           lease_token = CASE WHEN $3 THEN NULL ELSE lease_token END,
           lease_expires_at = CASE WHEN $3 THEN NULL ELSE now() + interval '2 minutes' END,
           updated_at = now()
         WHERE job_name = $1 AND status = 'RUNNING' AND lease_token = $2
         RETURNING job_name`,
        [JOB_NAME, leaseToken, completed, updated,
          row?.last_session_id ?? null, row?.last_group_id ?? null, row?.last_participant_id ?? null],
      );
      if (state.rowCount !== 1) return { updated: 0, completed: false, lostOwnership: true };
      return { updated, completed, lostOwnership: false };
    });
  }

  async release(leaseToken: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE contact_member_identity_backfill_state SET status = 'PENDING',
         next_attempt_at = now(), lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE job_name = $1 AND status = 'RUNNING' AND lease_token = $2
         AND lease_expires_at > now()`,
      [JOB_NAME, leaseToken],
    );
    return result.rowCount === 1;
  }

  async fail(leaseToken: string, errorCode: string): Promise<void> {
    await this.database.query(
      `UPDATE contact_member_identity_backfill_state SET status = 'RETRY',
         next_attempt_at = now() + LEAST(300, 5 * power(2, LEAST(attempt_count, 6))) * interval '1 second',
         lease_token = NULL, lease_expires_at = NULL, last_error_code = $3, updated_at = now()
       WHERE job_name = $1 AND status = 'RUNNING' AND lease_token = $2`,
      [JOB_NAME, leaseToken, errorCode],
    );
  }
}
