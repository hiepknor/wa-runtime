import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';
import { acquireSessionTransactionLock } from '../../core/database/session-transaction-lock';
import { enqueueContactProjectionWork } from './contact-projection.enqueue';
import {
  ContactProjectionBatchRepository,
  type ContactProjectionBatchResult,
  type ContactProjectionClaim,
} from './contact-projection-batch.repository';

export type { ContactProjectionBatchResult, ContactProjectionClaim } from './contact-projection-batch.repository';

export interface ContactProjectionQueueMetrics {
  pending: number;
  inactivePending: number;
  failed: number;
  oldestLagSeconds: number;
}

@Injectable()
export class ContactProjectionRepository {
  private readonly batches: ContactProjectionBatchRepository;

  constructor(
    private readonly database: DatabaseService,
    private readonly mirrorLegacyProjection = false,
    private readonly allowedSessionIds: string[] | null = null,
  ) {
    this.batches = new ContactProjectionBatchRepository(database, mirrorLegacyProjection);
  }

  async backfillEvidence(limit: number): Promise<number> {
    return this.database.transaction(async client => {
      const state = await client.query<{
        last_session_id: string | null;
        last_group_id: string | null;
        last_participant_id: string | null;
      }>(
        `SELECT last_session_id, last_group_id, last_participant_id
         FROM contact_evidence_backfill_state
         WHERE job_name = 'MEMBER_EVIDENCE_V2' AND status = 'PENDING'
         FOR UPDATE SKIP LOCKED`,
      );
      const cursor = state.rows[0];
      if (!cursor) return 0;
      await client.query(
        `CREATE TEMP TABLE member_evidence_backfill_page ON COMMIT DROP AS
         SELECT member.session_id, member.group_id, member.participant_id,
           CASE
             WHEN member.participant_id LIKE '%@lid' THEN 'LID'
             WHEN member.participant_id LIKE '%@c.us'
               OR member.participant_id LIKE '%@s.whatsapp.net' THEN 'PHONE_JID'
             ELSE 'OTHER_JID'
           END AS identity_type,
           CASE WHEN member.participant_id LIKE '%@s.whatsapp.net'
             THEN regexp_replace(member.participant_id, '@s\.whatsapp\.net$', '@c.us')
             ELSE member.participant_id END AS identity_value,
           CASE WHEN (member.participant_id LIKE '%@c.us'
                  OR member.participant_id LIKE '%@s.whatsapp.net')
                 AND COALESCE(member.resolved_phone_number,
                   regexp_replace(member.participant_id, '@(c\.us|s\.whatsapp\.net)$', ''))
                   ~ '^[0-9]+$'
             THEN COALESCE(member.resolved_phone_number,
               regexp_replace(member.participant_id, '@(c\.us|s\.whatsapp\.net)$', ''))
             ELSE NULL END AS phone,
           member.participant_display_name, member.synced_at
         FROM group_members member
         WHERE ($2::text IS NULL OR (member.session_id, member.group_id, member.participant_id)
           > ($2, $3, $4))
         ORDER BY member.session_id, member.group_id, member.participant_id LIMIT $1`,
        [limit, cursor.last_session_id, cursor.last_group_id, cursor.last_participant_id],
      );
      const page = await client.query<{
        count: string;
        last_session_id: string | null;
        last_group_id: string | null;
        last_participant_id: string | null;
      }>(
        `SELECT count(*)::text AS count,
           (array_agg(session_id ORDER BY session_id DESC, group_id DESC, participant_id DESC))[1]
             AS last_session_id,
           (array_agg(group_id ORDER BY session_id DESC, group_id DESC, participant_id DESC))[1]
             AS last_group_id,
           (array_agg(participant_id ORDER BY session_id DESC, group_id DESC, participant_id DESC))[1]
             AS last_participant_id
         FROM member_evidence_backfill_page`,
      );
      const count = Number(page.rows[0]?.count ?? 0);
      if (count > 0) {
        await this.materializeEvidenceBackfillPage(client);
      }
      const last = page.rows[0];
      await client.query(
        `UPDATE contact_evidence_backfill_state SET
           status = CASE WHEN $1::integer < $2 THEN 'COMPLETED' ELSE 'PENDING' END,
           last_session_id = COALESCE($3, last_session_id),
           last_group_id = COALESCE($4, last_group_id),
           last_participant_id = COALESCE($5, last_participant_id),
           rows_processed = rows_processed + $1,
           completed_at = CASE WHEN $1::integer < $2 THEN now() ELSE NULL END,
           updated_at = now()
         WHERE job_name = 'MEMBER_EVIDENCE_V2'`,
        [count, limit, last?.last_session_id, last?.last_group_id, last?.last_participant_id],
      );
      return count;
    });
  }

  async catchUpMissingEvidence(limit: number): Promise<number> {
    return this.database.transaction(async client => {
      const lock = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_xact_lock(
           hashtextextended('contacts:evidence:late-catch-up', 0)
         ) AS acquired`,
      );
      if (!lock.rows[0]?.acquired) return 0;
      const candidate = await client.query<{ session_id: string }>(
        `SELECT member.session_id
         FROM group_members member
         WHERE member.evidence_identity_id IS NULL
           AND ($1::text[] IS NULL OR member.session_id = ANY($1::text[]))
         ORDER BY member.session_id, member.group_id, member.participant_id LIMIT 1`,
        [this.allowedSessionIds],
      );
      const sessionId = candidate.rows[0]?.session_id;
      if (!sessionId) return 0;
      await acquireSessionTransactionLock(client, 'contact-member-projection', sessionId);
      await client.query(
        `CREATE TEMP TABLE member_evidence_backfill_page ON COMMIT DROP AS
         SELECT member.session_id, member.group_id, member.participant_id,
           CASE
             WHEN member.participant_id LIKE '%@lid' THEN 'LID'
             WHEN member.participant_id LIKE '%@c.us'
               OR member.participant_id LIKE '%@s.whatsapp.net' THEN 'PHONE_JID'
             ELSE 'OTHER_JID'
           END AS identity_type,
           CASE WHEN member.participant_id LIKE '%@s.whatsapp.net'
             THEN regexp_replace(member.participant_id, '@s\.whatsapp\.net$', '@c.us')
             ELSE member.participant_id END AS identity_value,
           CASE WHEN (member.participant_id LIKE '%@c.us'
                  OR member.participant_id LIKE '%@s.whatsapp.net')
                 AND COALESCE(member.resolved_phone_number,
                   regexp_replace(member.participant_id, '@(c\.us|s\.whatsapp\.net)$', ''))
                   ~ '^[0-9]+$'
             THEN COALESCE(member.resolved_phone_number,
               regexp_replace(member.participant_id, '@(c\.us|s\.whatsapp\.net)$', ''))
             ELSE NULL END AS phone,
           member.participant_display_name, member.synced_at
         FROM group_members member
         WHERE member.session_id = $1 AND member.evidence_identity_id IS NULL
         ORDER BY member.group_id, member.participant_id LIMIT $2`,
        [sessionId, limit],
      );
      return this.materializeEvidenceBackfillPage(client);
    });
  }

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

  private async materializeEvidenceBackfillPage(client: PoolClient): Promise<number> {
    await client.query(
      `INSERT INTO observed_contact_identities
         (session_id, identity_type, identity_value, first_observed_at, last_observed_at)
       SELECT session_id, identity_type, identity_value, min(synced_at), max(synced_at)
       FROM member_evidence_backfill_page
       GROUP BY session_id, identity_type, identity_value
       ON CONFLICT (session_id, identity_type, identity_value) DO UPDATE SET
         first_observed_at = LEAST(observed_contact_identities.first_observed_at,
           EXCLUDED.first_observed_at),
         last_observed_at = GREATEST(observed_contact_identities.last_observed_at,
           EXCLUDED.last_observed_at), updated_at = now()`,
    );
    await client.query(
      `INSERT INTO observed_contact_identities
         (session_id, identity_type, identity_value, first_observed_at, last_observed_at)
       SELECT session_id, 'PHONE', phone, min(synced_at), max(synced_at)
       FROM member_evidence_backfill_page WHERE phone IS NOT NULL
       GROUP BY session_id, phone
       ON CONFLICT (session_id, identity_type, identity_value) DO UPDATE SET
         first_observed_at = LEAST(observed_contact_identities.first_observed_at,
           EXCLUDED.first_observed_at),
         last_observed_at = GREATEST(observed_contact_identities.last_observed_at,
           EXCLUDED.last_observed_at), updated_at = now()`,
    );
    await client.query(
      `INSERT INTO contact_observations
         (session_id, identity_id, observation_source, observation_scope,
          group_id, participant_id, name_value, source_observed_at, source_observation_key)
       SELECT page.session_id, identity.id, 'GROUP_PARTICIPANT_NAME', 'MEMBERSHIP',
         page.group_id, page.participant_id, page.participant_display_name, page.synced_at,
         'backfill:group:' || md5(page.group_id || ':' || page.participant_id || ':'
           || page.participant_display_name)
       FROM member_evidence_backfill_page page
       JOIN observed_contact_identities identity
         ON identity.session_id = page.session_id
        AND identity.identity_type = page.identity_type
        AND identity.identity_value = page.identity_value
       WHERE page.participant_display_name IS NOT NULL
       ON CONFLICT (session_id, observation_source, source_observation_key) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO contact_link_evidence
         (session_id, left_identity_id, right_identity_id, evidence_source,
          source_observed_at, source_observation_key)
       SELECT page.session_id, exact.id, phone.id, 'PHONE_JID_DERIVATION', page.synced_at,
         'backfill:derived:' || md5(page.identity_value || ':' || page.phone)
       FROM member_evidence_backfill_page page
       JOIN observed_contact_identities exact
         ON exact.session_id = page.session_id AND exact.identity_type = page.identity_type
        AND exact.identity_value = page.identity_value
       JOIN observed_contact_identities phone
         ON phone.session_id = page.session_id AND phone.identity_type = 'PHONE'
        AND phone.identity_value = page.phone
       WHERE page.identity_type = 'PHONE_JID' AND page.phone IS NOT NULL
       ON CONFLICT (session_id, evidence_source, source_observation_key) DO NOTHING`,
    );
    const identities = await client.query<{ session_id: string; identity_id: string }>(
      `UPDATE group_members member SET evidence_identity_id = identity.id,
         identity_type = page.identity_type, updated_at = now()
       FROM member_evidence_backfill_page page
       JOIN observed_contact_identities identity
         ON identity.session_id = page.session_id
        AND identity.identity_type = page.identity_type
        AND identity.identity_value = page.identity_value
       WHERE member.session_id = page.session_id AND member.group_id = page.group_id
         AND member.participant_id = page.participant_id
         AND (member.evidence_identity_id, member.identity_type)
           IS DISTINCT FROM (identity.id, page.identity_type)
       RETURNING member.session_id, identity.id AS identity_id`,
    );
    const bySession = new Map<string, string[]>();
    for (const row of identities.rows) {
      const values = bySession.get(row.session_id) ?? [];
      values.push(row.identity_id);
      bySession.set(row.session_id, values);
    }
    for (const [sessionId, identityIds] of bySession) {
      await enqueueContactProjectionWork(client, sessionId, identityIds);
    }
    return identities.rowCount ?? 0;
  }

  async coalesceResolvedAliases(limit: number): Promise<number> {
    return this.database.transaction(async client => {
      const result = await client.query<{ session_id: string; identity_id: string }>(
        `SELECT work.session_id, work.identity_id
         FROM contact_projection_work work
         JOIN LATERAL (
           SELECT run.id FROM contact_resolution_runs run
           WHERE run.session_id = work.session_id AND run.status = 'COMPLETED'
           ORDER BY run.completed_at DESC, run.id DESC LIMIT 1
         ) latest_run ON true
         JOIN resolved_identity_assignments assignment
           ON assignment.session_id = work.session_id AND assignment.run_id = latest_run.id
          AND assignment.identity_id = work.identity_id
         WHERE work.status IN ('PENDING', 'RETRY', 'FAILED')
           AND assignment.resolution_status = 'RESOLVED'
           AND assignment.cluster_id <> work.identity_id
           AND ($2::text[] IS NULL OR work.session_id = ANY($2::text[]))
         ORDER BY work.first_requested_at, work.session_id, work.identity_id
         FOR UPDATE OF work SKIP LOCKED LIMIT $1`,
        [limit, this.allowedSessionIds],
      );
      const bySession = new Map<string, string[]>();
      for (const row of result.rows) {
        const identities = bySession.get(row.session_id) ?? [];
        identities.push(row.identity_id);
        bySession.set(row.session_id, identities);
      }
      let enqueued = 0;
      for (const [sessionId, identities] of bySession) {
        enqueued += await enqueueContactProjectionWork(client, sessionId, identities);
      }
      return enqueued;
    });
  }

  async catchUpUnprojected(limit: number): Promise<number> {
    return this.database.transaction(async client => {
      const lock = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_xact_lock(
           hashtextextended('contacts:projection:catch-up', 0)
         ) AS acquired`,
      );
      if (!lock.rows[0]?.acquired) return 0;
      const result = await client.query<{ session_id: string; projection_identity_id: string }>(
        `SELECT DISTINCT member.session_id,
           CASE WHEN assignment.resolution_status = 'RESOLVED' THEN assignment.cluster_id
             ELSE member.evidence_identity_id END AS projection_identity_id
         FROM group_members member
         LEFT JOIN LATERAL (
           SELECT run.id FROM contact_resolution_runs run
           WHERE run.session_id = member.session_id AND run.status = 'COMPLETED'
           ORDER BY run.completed_at DESC, run.id DESC LIMIT 1
         ) latest_run ON true
         LEFT JOIN resolved_identity_assignments assignment
           ON assignment.session_id = member.session_id AND assignment.run_id = latest_run.id
          AND assignment.identity_id = member.evidence_identity_id
         LEFT JOIN contact_projection_work work
           ON work.session_id = member.session_id
          AND work.identity_id = CASE
            WHEN assignment.resolution_status = 'RESOLVED' THEN assignment.cluster_id
            ELSE member.evidence_identity_id
          END
         WHERE member.evidence_identity_id IS NOT NULL
           AND (member.shadow_projection_revision = 0 OR member.identity_type IS NULL)
           AND ($2::text[] IS NULL OR member.session_id = ANY($2::text[]))
           AND (work.identity_id IS NULL OR work.status IN ('IDLE', 'FAILED'))
         ORDER BY member.session_id, projection_identity_id LIMIT $1`,
        [limit, this.allowedSessionIds],
      );
      const bySession = new Map<string, string[]>();
      for (const row of result.rows) {
        const identities = bySession.get(row.session_id) ?? [];
        identities.push(row.projection_identity_id);
        bySession.set(row.session_id, identities);
      }
      let enqueued = 0;
      for (const [sessionId, identities] of bySession) {
        enqueued += await enqueueContactProjectionWork(client, sessionId, identities);
      }
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
         WHERE ($1::text[] IS NULL OR session_id = ANY($1::text[])) AND (
           (status IN ('PENDING', 'RETRY') AND next_attempt_at <= now())
           OR (status = 'RUNNING' AND lease_expires_at < now())
         )
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
      [this.allowedSessionIds],
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
      inactive_pending: string;
      failed: string;
      oldest_lag_seconds: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE status IN ('PENDING', 'RUNNING', 'RETRY'))::text AS pending,
         count(*) FILTER (
           WHERE status IN ('PENDING', 'RUNNING', 'RETRY')
             AND $1::text[] IS NOT NULL AND NOT (session_id = ANY($1::text[]))
         )::text AS inactive_pending,
         count(*) FILTER (WHERE status = 'FAILED'
           AND ($1::text[] IS NULL OR session_id = ANY($1::text[])))::text AS failed,
         COALESCE(max(extract(epoch FROM now() - first_requested_at))
           FILTER (WHERE status IN ('PENDING', 'RUNNING', 'RETRY')
             AND ($1::text[] IS NULL OR session_id = ANY($1::text[]))), 0)::text
           AS oldest_lag_seconds
       FROM contact_projection_work`,
      [this.allowedSessionIds],
    );
    const row = result.rows[0];
    return {
      pending: Number(row?.pending ?? 0) - Number(row?.inactive_pending ?? 0),
      inactivePending: Number(row?.inactive_pending ?? 0),
      failed: Number(row?.failed ?? 0),
      oldestLagSeconds: Number(row?.oldest_lag_seconds ?? 0),
    };
  }

  async projectBatch(
    claim: ContactProjectionClaim,
    batchSize: number,
  ): Promise<ContactProjectionBatchResult> {
    return this.batches.project(claim, batchSize);
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
