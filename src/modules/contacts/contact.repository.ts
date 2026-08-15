import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { OpenWAGroupParticipant } from '../../integrations/openwa/openwa.client';
import type { OpenWAContact } from '../../integrations/openwa/openwa.client';
import { normalizeContactIdentity, normalizeContactName } from './contact-normalization';
import { DatabaseService } from '../../core/database/database.service';
import { contactNameProjectionSql, memberNameProjectionSql } from './contact-name-resolution.sql';
import { ContactSnapshotConflictError } from './contact-snapshot.errors';
import { ContactEvidenceWriter } from './contact-evidence.writer';

interface GroupMemberContactInput {
  participant_id: string;
  identity_type: 'LID' | 'PHONE_JID' | 'OTHER_JID';
  identity_value: string;
  phone: string | null;
  participant_name: string | null;
  candidate_contact_id: string;
}

const inputRelation = `jsonb_to_recordset($3::jsonb) AS member(
  participant_id text, identity_type text, identity_value text, phone text,
  participant_name text, candidate_contact_id uuid
)`;

const contactProjection = contactNameProjectionSql({
  contactName: 'contact_source.name_value',
  pushName: 'push_source.name_value',
});
const observedContactProjection = contactNameProjectionSql({
  contactName: 'contact_source.name_value',
  pushName: 'name_write.name_value',
});
const memberProjection = memberNameProjectionSql({
  contactName: 'contact.effective_display_name',
  contactSource: 'contact.display_name_source',
  participantName: 'member.participant_display_name',
});
const observedMemberProjection = memberNameProjectionSql({
  contactName: 'contact_write.effective_display_name',
  contactSource: 'contact_write.display_name_source',
  participantName: 'member.participant_display_name',
});
const resolvedMemberProjection = memberNameProjectionSql({
  contactName: 'resolved.effective_display_name',
  contactSource: 'resolved.contact_name_source',
  participantName: 'resolved.participant_name',
});

@Injectable()
export class ContactRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly snapshotStagingEnabled = false,
    private readonly snapshotRetentionDays = 30,
    private readonly evidenceWriter = new ContactEvidenceWriter(false),
    private readonly legacyMemberFanoutEnabled = true,
  ) {}

  async listPeriodicSessionIds(allowedSessionIds: string[], limit: number): Promise<string[]> {
    const result = await this.database.query<{ id: string }>(
      `SELECT session.id FROM gateway_sessions session
       LEFT JOIN contact_sync_state state ON state.session_id = session.id
       WHERE session.id = ANY($1::text[]) AND session.status = 'ready' AND session.engine_loaded = true
         AND (state.session_id IS NULL OR state.next_attempt_at <= now())
         AND (state.lease_token IS NULL OR state.lease_expires_at < now())
       ORDER BY state.next_attempt_at NULLS FIRST, session.id LIMIT $2`,
      [allowedSessionIds, limit],
    );
    return result.rows.map(row => row.id);
  }

  async getCoverageMetrics(sessionId: string): Promise<Record<string, number>> {
    const result = await this.database.query<Record<string, string>>(
      `SELECT
         count(*)::text AS member_records,
         count(*) FILTER (WHERE member.contact_id IS NOT NULL)::text AS linked_records,
         count(*) FILTER (WHERE member.display_name IS NOT NULL)::text AS named_records,
         count(*) FILTER (WHERE identifier.identity_type = 'LID')::text AS lid_records,
         count(*) FILTER (WHERE identifier.identity_type = 'LID'
           AND member.display_name IS NOT NULL)::text AS named_lid_records,
         count(*) FILTER (WHERE identifier.identity_type = 'PHONE_JID')::text AS phone_jid_records,
         count(*) FILTER (WHERE identifier.identity_type = 'PHONE_JID'
           AND member.display_name IS NOT NULL)::text AS named_phone_jid_records,
         count(*) FILTER (WHERE member.display_name_source = 'OPENWA_CONTACT_NAME')::text AS contact_name_records,
         count(*) FILTER (WHERE member.display_name_source = 'GROUP_PARTICIPANT_NAME')::text AS participant_name_records,
         count(*) FILTER (WHERE member.display_name_source = 'OPENWA_PUSH_NAME')::text AS push_name_records,
         count(*) FILTER (WHERE member.shadow_projection_revision > 0)::text AS shadow_projected_records,
         count(*) FILTER (WHERE member.shadow_display_name IS NOT NULL)::text AS shadow_named_records,
         count(*) FILTER (WHERE member.shadow_resolved_phone_number IS NOT NULL)::text
           AS shadow_resolved_phone_records,
         count(*) FILTER (WHERE member.shadow_display_name_source = 'RESOLVED_ALIAS_PUSH_NAME')::text
           AS shadow_alias_push_records
       FROM group_members member
       LEFT JOIN contact_identifiers identifier
         ON identifier.session_id = member.session_id AND identifier.contact_id = member.contact_id
        AND identifier.identity_type = CASE
          WHEN member.participant_id LIKE '%@lid' THEN 'LID'
          WHEN member.participant_id LIKE '%@c.us' OR member.participant_id LIKE '%@s.whatsapp.net'
            THEN 'PHONE_JID'
          ELSE 'OTHER_JID'
        END
        AND identifier.identity_value = CASE
          WHEN member.participant_id LIKE '%@s.whatsapp.net'
            THEN regexp_replace(member.participant_id, '@s\\.whatsapp\\.net$', '@c.us')
          ELSE member.participant_id
        END
       WHERE member.session_id = $1`,
      [sessionId],
    );
    return Object.fromEntries(
      Object.entries(result.rows[0] ?? {}).map(([key, value]) => [key, Number(value)]),
    );
  }

  async beginObservedSnapshot(sessionId: string, force = true): Promise<{
    generation: number;
    leaseToken: string;
  } | null> {
    const claimSql = `INSERT INTO contact_sync_state
         (session_id, sync_generation, last_started_at, last_error_code, lease_token, lease_expires_at)
       VALUES ($1, 1, now(), NULL, gen_random_uuid(), now() + interval '10 minutes')
       ON CONFLICT (session_id) DO UPDATE SET
         sync_generation = contact_sync_state.sync_generation + 1,
         last_started_at = now(), last_error_code = NULL,
         attempt_count = contact_sync_state.attempt_count + 1,
         lease_token = gen_random_uuid(), lease_expires_at = now() + interval '10 minutes', updated_at = now()
       WHERE (contact_sync_state.lease_token IS NULL OR contact_sync_state.lease_expires_at < now())
         AND ($2 OR contact_sync_state.next_attempt_at <= now())
       RETURNING sync_generation, lease_token`;
    if (!this.snapshotStagingEnabled) {
      const result = await this.database.query<{ sync_generation: string; lease_token: string }>(
        claimSql,
        [sessionId, force],
      );
      const row = result.rows[0];
      return row ? { generation: Number(row.sync_generation), leaseToken: row.lease_token } : null;
    }
    return this.database.transaction(async client => {
      const result = await client.query<{ sync_generation: string; lease_token: string }>(
        claimSql,
        [sessionId, force],
      );
      const row = result.rows[0];
      if (!row) return null;
      await client.query(
        `UPDATE contact_snapshot_generations
         SET state = 'FAILED', failed_at = now(), error_code = 'LEASE_EXPIRED', updated_at = now()
         WHERE session_id = $1 AND state = 'RECEIVING' AND generation < $2`,
        [sessionId, row.sync_generation],
      );
      await client.query(
        `DELETE FROM contact_snapshot_generations generation_state
         WHERE generation_state.session_id = $1
           AND generation_state.state IN ('PUBLISHED', 'FAILED')
           AND generation_state.created_at < now() - $2 * interval '1 day'
           AND generation_state.generation <> COALESCE((
             SELECT max(published.generation) FROM contact_snapshot_generations published
             WHERE published.session_id = $1 AND published.state = 'PUBLISHED'
           ), -1)
           AND generation_state.generation <> COALESCE((
             SELECT resolved.source_generation FROM contact_resolution_runs resolved
             WHERE resolved.session_id = $1 AND resolved.status = 'COMPLETED'
             ORDER BY resolved.completed_at DESC, resolved.id DESC LIMIT 1
           ), -1)`,
        [sessionId, this.snapshotRetentionDays],
      );
      await client.query(
        `INSERT INTO contact_snapshot_generations
           (session_id, generation, state, lease_token)
         VALUES ($1, $2, 'RECEIVING', $3)`,
        [sessionId, row.sync_generation, row.lease_token],
      );
      return { generation: Number(row.sync_generation), leaseToken: row.lease_token };
    });
  }

  async ingestObservedPage(
    sessionId: string,
    generation: number,
    leaseToken: string,
    contacts: OpenWAContact[],
  ): Promise<{
    observed: number;
    enriched: number;
  }> {
    if (contacts.length === 0) return { observed: 0, enriched: 0 };
    const rows = contacts.map(contact => {
      const identity = normalizeContactIdentity(contact.id);
      const contactName = normalizeContactName(contact.name, identity);
      const pushName = normalizeContactName(contact.pushName, identity);
      const upstreamPhone = contact.number.trim();
      const phone = identity.type === 'LID'
        ? (/^\d+$/u.test(upstreamPhone) && upstreamPhone !== identity.value.replace(/@lid$/u, '')
          ? upstreamPhone : null)
        : identity.phone;
      return {
        identity_type: identity.type,
        identity_value: identity.value,
        phone,
        contact_name: contactName,
        push_name: pushName,
        candidate_contact_id: randomUUID(),
      };
    });
    return this.database.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [sessionId]);
      const ownership = await client.query(
        `UPDATE contact_sync_state SET lease_expires_at = now() + interval '10 minutes', updated_at = now()
         WHERE session_id = $1 AND sync_generation = $2 AND lease_token = $3
           AND lease_expires_at > now()`,
        [sessionId, generation, leaseToken],
      );
      if (ownership.rowCount !== 1) throw new Error('Contact snapshot lost write ownership');
      const pageJson = JSON.stringify(rows);
      const pageRelation = `jsonb_to_recordset($2::jsonb) AS contact(
        identity_type text, identity_value text, phone text, contact_name text,
        push_name text, candidate_contact_id uuid
      )`;
      if (this.snapshotStagingEnabled) {
        await client.query(
          `WITH input AS MATERIALIZED (SELECT * FROM ${pageRelation})
           INSERT INTO contact_snapshot_observations
             (session_id, generation, identity_type, identity_value, phone,
              contact_name, push_name, source_observation_key)
           SELECT $1, $3::bigint, input.identity_type, input.identity_value, input.phone,
             input.contact_name, input.push_name,
             'snapshot:' || $3::bigint::text || ':'
               || md5(input.identity_type || ':' || input.identity_value)
           FROM input
           ON CONFLICT (session_id, generation, identity_type, identity_value) DO NOTHING`,
          [sessionId, pageJson, generation],
        );
        const validation = await client.query<{ conflicts: string }>(
          `WITH input AS MATERIALIZED (SELECT * FROM ${pageRelation})
           SELECT count(*)::text AS conflicts
           FROM input
           LEFT JOIN contact_snapshot_observations staged
             ON staged.session_id = $1 AND staged.generation = $3::bigint
            AND staged.identity_type = input.identity_type
            AND staged.identity_value = input.identity_value
           WHERE staged.identity_value IS NULL
              OR (staged.phone, staged.contact_name, staged.push_name)
                IS DISTINCT FROM (input.phone, input.contact_name, input.push_name)`,
          [sessionId, pageJson, generation],
        );
        if (validation.rows[0]?.conflicts !== '0') {
          throw new ContactSnapshotConflictError();
        }
      }
      await client.query(
        `WITH input AS MATERIALIZED (SELECT * FROM ${pageRelation}),
         missing AS MATERIALIZED (
           SELECT DISTINCT ON (input.identity_type, input.identity_value) input.*
           FROM input LEFT JOIN contact_identifiers identifier
             ON identifier.session_id = $1 AND identifier.identity_type = input.identity_type
            AND identifier.identity_value = input.identity_value
           WHERE identifier.contact_id IS NULL
           ORDER BY input.identity_type, input.identity_value, input.candidate_contact_id
         ), created AS (
           INSERT INTO contacts (session_id, id)
           SELECT $1, missing.candidate_contact_id FROM missing ON CONFLICT DO NOTHING
         )
         INSERT INTO contact_identifiers
           (session_id, contact_id, identity_type, identity_value, mapping_source)
         SELECT $1, missing.candidate_contact_id, missing.identity_type,
           missing.identity_value, 'OPENWA_CONTACT'
         FROM missing
         ON CONFLICT (session_id, identity_type, identity_value) DO UPDATE SET
           last_observed_at = now(), updated_at = now()`,
        [sessionId, pageJson],
      );
      await client.query(
        `WITH input AS MATERIALIZED (SELECT * FROM ${pageRelation})
         INSERT INTO contact_identity_evidence
           (session_id, sync_generation, identity_type, identity_value, phone)
         SELECT $1, $3, identity_type, identity_value, phone FROM input WHERE phone IS NOT NULL
         ON CONFLICT (session_id, sync_generation, identity_type, identity_value) DO UPDATE SET
           phone = EXCLUDED.phone, observed_at = now()`,
        [sessionId, pageJson, generation],
      );
      await client.query(
        `WITH input AS MATERIALIZED (SELECT * FROM ${pageRelation}),
         matched AS MATERIALIZED (
           SELECT input.*, identifier.contact_id,
             phone_identifier.contact_id AS phone_contact_id
           FROM input JOIN contact_identifiers identifier
             ON identifier.session_id = $1 AND identifier.identity_type = input.identity_type
            AND identifier.identity_value = input.identity_value
           LEFT JOIN contact_identifiers phone_identifier
             ON phone_identifier.session_id = $1 AND phone_identifier.identity_type = 'PHONE'
            AND phone_identifier.identity_value = input.phone
         ), touched AS (
           UPDATE contacts contact SET last_observed_at = now(), updated_at = now()
           FROM matched WHERE contact.session_id = $1 AND contact.id = matched.contact_id
         ), identity_touched AS (
           UPDATE contact_identifiers identifier SET last_observed_at = now(), updated_at = now()
           FROM matched WHERE identifier.session_id = $1 AND identifier.contact_id = matched.contact_id
             AND identifier.identity_type = matched.identity_type
             AND identifier.identity_value = matched.identity_value
         )
         INSERT INTO contact_identifiers
           (session_id, contact_id, identity_type, identity_value, mapping_source)
         SELECT DISTINCT ON (matched.phone)
           $1, COALESCE(matched.phone_contact_id, matched.contact_id),
           'PHONE', matched.phone, 'OPENWA_CONTACT_PHONE'
         FROM matched WHERE matched.phone IS NOT NULL
         ORDER BY matched.phone,
           (matched.phone_contact_id IS NOT NULL) DESC,
           (matched.identity_type = 'PHONE_JID') DESC,
           matched.identity_value, matched.contact_id
         ON CONFLICT (session_id, identity_type, identity_value) DO UPDATE SET
           last_observed_at = now(), updated_at = now()`,
        [sessionId, pageJson],
      );
      await client.query(
        `WITH input AS MATERIALIZED (SELECT * FROM ${pageRelation}),
         matched AS MATERIALIZED (
           SELECT input.*, identifier.contact_id FROM input JOIN contact_identifiers identifier
             ON identifier.session_id = $1 AND identifier.identity_type = input.identity_type
            AND identifier.identity_value = input.identity_value
         ), contact_names_write AS (
           INSERT INTO contact_names
             (session_id, contact_id, name_source, name_value,
              source_observed_at, source_observation_key)
           SELECT DISTINCT ON (matched.contact_id)
             $1, matched.contact_id, 'OPENWA_CONTACT_NAME', matched.contact_name,
             now(), 'snapshot:' || $3::text || ':contact:'
               || md5(matched.identity_type || ':' || matched.identity_value)
           FROM matched WHERE matched.contact_name IS NOT NULL
           ORDER BY matched.contact_id, matched.identity_value
           ON CONFLICT (session_id, contact_id, name_source) DO UPDATE SET
             name_value = EXCLUDED.name_value,
             source_observed_at = EXCLUDED.source_observed_at,
             source_observation_key = EXCLUDED.source_observation_key,
             last_observed_at = now(), updated_at = now()
           WHERE (contact_names.source_observed_at, contact_names.source_observation_key)
             < (EXCLUDED.source_observed_at, EXCLUDED.source_observation_key)
         )
         INSERT INTO contact_names
           (session_id, contact_id, name_source, name_value,
            source_observed_at, source_observation_key)
         SELECT DISTINCT ON (matched.contact_id)
           $1, matched.contact_id, 'OPENWA_PUSH_NAME', matched.push_name,
           now(), 'snapshot:' || $3::text || ':push:'
             || md5(matched.identity_type || ':' || matched.identity_value)
         FROM matched WHERE matched.push_name IS NOT NULL
         ORDER BY matched.contact_id, matched.identity_value
         ON CONFLICT (session_id, contact_id, name_source) DO UPDATE SET
           name_value = EXCLUDED.name_value,
           source_observed_at = EXCLUDED.source_observed_at,
           source_observation_key = EXCLUDED.source_observation_key,
           last_observed_at = now(), updated_at = now()
         WHERE (contact_names.source_observed_at, contact_names.source_observation_key)
           < (EXCLUDED.source_observed_at, EXCLUDED.source_observation_key)`,
        [sessionId, pageJson, generation],
      );
      await client.query(
        `WITH affected AS MATERIALIZED (
           SELECT DISTINCT identifier.contact_id FROM ${pageRelation}
           JOIN contact_identifiers identifier
             ON identifier.session_id = $1 AND identifier.identity_type = contact.identity_type
            AND identifier.identity_value = contact.identity_value
         ), effective AS MATERIALIZED (
           SELECT affected.contact_id,
             ${contactProjection.name} AS name_value,
             ${contactProjection.source} AS name_source
           FROM affected
           LEFT JOIN contact_names contact_source ON contact_source.session_id = $1
             AND contact_source.contact_id = affected.contact_id AND contact_source.name_source = 'OPENWA_CONTACT_NAME'
           LEFT JOIN contact_names push_source ON push_source.session_id = $1
             AND push_source.contact_id = affected.contact_id AND push_source.name_source = 'OPENWA_PUSH_NAME'
         )
         UPDATE contacts target SET effective_display_name = effective.name_value,
           display_name_source = effective.name_source, updated_at = now()
         FROM effective WHERE target.session_id = $1 AND target.id = effective.contact_id
           AND (target.effective_display_name, target.display_name_source)
             IS DISTINCT FROM (effective.name_value, effective.name_source)`,
        [sessionId, pageJson],
      );
      const result = await client.query<{ enriched: string }>(
        `WITH input AS MATERIALIZED (SELECT * FROM ${pageRelation}),
         affected AS MATERIALIZED (
           SELECT DISTINCT identifier.contact_id, input.phone,
             phone_identifier.contact_id AS phone_contact_id
           FROM input JOIN contact_identifiers identifier
             ON identifier.session_id = $1 AND identifier.identity_type = input.identity_type
            AND identifier.identity_value = input.identity_value
           LEFT JOIN contact_identifiers phone_identifier
             ON phone_identifier.session_id = $1 AND phone_identifier.identity_type = 'PHONE'
            AND phone_identifier.identity_value = input.phone
         ), member_writes AS (
           UPDATE group_members member SET display_name = ${memberProjection.name},
             display_name_source = ${memberProjection.source},
             display_name_updated_at = CASE WHEN ${memberProjection.name} IS NULL THEN NULL ELSE now() END,
             updated_at = now()
           FROM contacts contact, affected
           WHERE contact.session_id = $1 AND contact.id = affected.contact_id
             AND member.session_id = $1 AND member.contact_id = contact.id
             AND $3::boolean
             AND (member.display_name, member.display_name_source)
               IS DISTINCT FROM (${memberProjection.name}, ${memberProjection.source})
           RETURNING member.contact_id
         )
         SELECT (SELECT count(*) FROM member_writes)::text AS enriched`,
        [sessionId, pageJson, this.legacyMemberFanoutEnabled],
      );
      return {
        observed: rows.length,
        enriched: Number(result.rows[0]?.enriched ?? 0),
      };
    });
  }

  async reconcileObservedIdentities(
    sessionId: string,
    generation: number,
    leaseToken: string,
  ): Promise<{ merged: number; conflicts: number; enriched: number }> {
    return this.database.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [sessionId]);
      const ownership = await client.query(
        `UPDATE contact_sync_state SET lease_expires_at = now() + interval '10 minutes', updated_at = now()
         WHERE session_id = $1 AND sync_generation = $2 AND lease_token = $3
           AND lease_expires_at > now()`,
        [sessionId, generation, leaseToken],
      );
      if (ownership.rowCount !== 1) throw new Error('Contact snapshot lost write ownership');
      await client.query(
        `CREATE TEMP TABLE contact_merge_plan ON COMMIT DROP AS
         WITH RECURSIVE phone_cardinality AS MATERIALIZED (
           SELECT phone, count(DISTINCT (identity_type, identity_value)) AS identity_count
           FROM contact_identity_evidence
           WHERE session_id = $1 AND sync_generation = $2 GROUP BY phone
         ), edges AS MATERIALIZED (
           SELECT DISTINCT exact_identifier.contact_id AS left_id,
             phone_identifier.contact_id AS right_id
           FROM contact_identity_evidence evidence
           JOIN phone_cardinality ON phone_cardinality.phone = evidence.phone
             AND phone_cardinality.identity_count = 1
           JOIN contact_identifiers exact_identifier
             ON exact_identifier.session_id = evidence.session_id
            AND exact_identifier.identity_type = evidence.identity_type
            AND exact_identifier.identity_value = evidence.identity_value
           JOIN contact_identifiers phone_identifier
             ON phone_identifier.session_id = evidence.session_id
            AND phone_identifier.identity_type = 'PHONE'
            AND phone_identifier.identity_value = evidence.phone
           WHERE evidence.session_id = $1 AND evidence.sync_generation = $2
             AND exact_identifier.contact_id <> phone_identifier.contact_id
         ), undirected AS (
           SELECT left_id AS source, right_id AS target FROM edges
           UNION SELECT right_id, left_id FROM edges
         ), reach(root, node) AS (
           SELECT source, source FROM undirected
           UNION
           SELECT reach.root, undirected.target FROM reach
           JOIN undirected ON undirected.source = reach.node
         ), component AS (
           SELECT node, min(root::text)::uuid AS component_id FROM reach GROUP BY node
         ), ranked AS (
           SELECT component.node,
             first_value(component.node) OVER (
               PARTITION BY component.component_id ORDER BY contact.created_at, component.node
             ) AS winner_id
           FROM component JOIN contacts contact ON contact.session_id = $1 AND contact.id = component.node
         )
         SELECT winner_id, node AS loser_id FROM ranked WHERE node <> winner_id`,
        [sessionId, generation],
      );
      const mappingRelation = 'contact_merge_plan AS mapping';
      await client.query(
        `WITH mapping AS MATERIALIZED (SELECT * FROM ${mappingRelation}),
         ranked AS MATERIALIZED (
           SELECT mapping.winner_id, name.name_source, name.name_value,
             name.first_observed_at, name.last_observed_at,
             name.source_observed_at, name.source_observation_key,
             row_number() OVER (
               PARTITION BY mapping.winner_id, name.name_source
               ORDER BY name.source_observed_at DESC, name.source_observation_key DESC,
                 name.contact_id, name.name_value
             ) AS rank
           FROM mapping JOIN contact_names name
             ON name.session_id = $1 AND name.contact_id IN (mapping.winner_id, mapping.loser_id)
         )
         INSERT INTO contact_names
           (session_id, contact_id, name_source, name_value, first_observed_at, last_observed_at,
            source_observed_at, source_observation_key)
         SELECT $1, winner_id, name_source, name_value, first_observed_at, last_observed_at,
           source_observed_at, source_observation_key
         FROM ranked WHERE rank = 1
         ON CONFLICT (session_id, contact_id, name_source) DO UPDATE SET
           name_value = EXCLUDED.name_value,
           first_observed_at = LEAST(contact_names.first_observed_at, EXCLUDED.first_observed_at),
           last_observed_at = GREATEST(contact_names.last_observed_at, EXCLUDED.last_observed_at),
           source_observed_at = EXCLUDED.source_observed_at,
           source_observation_key = EXCLUDED.source_observation_key,
           updated_at = now()
         WHERE (contact_names.source_observed_at, contact_names.source_observation_key)
           <= (EXCLUDED.source_observed_at, EXCLUDED.source_observation_key)`,
        [sessionId],
      );
      await client.query(
        `DELETE FROM contact_names name USING ${mappingRelation}
         WHERE name.session_id = $1 AND name.contact_id = mapping.loser_id`,
        [sessionId],
      );
      await client.query(
        `UPDATE contact_identifiers identifier SET contact_id = mapping.winner_id, updated_at = now()
         FROM ${mappingRelation}
         WHERE identifier.session_id = $1 AND identifier.contact_id = mapping.loser_id`,
        [sessionId],
      );
      await client.query(
        `UPDATE group_members member SET contact_id = mapping.winner_id, updated_at = now()
         FROM ${mappingRelation}
         WHERE member.session_id = $1 AND member.contact_id = mapping.loser_id`,
        [sessionId],
      );
      await client.query(
        `WITH mapping AS MATERIALIZED (SELECT * FROM ${mappingRelation}), aggregates AS (
           SELECT mapping.winner_id, min(contact.first_observed_at) AS first_observed_at,
             max(contact.last_observed_at) AS last_observed_at
           FROM mapping JOIN contacts contact
             ON contact.session_id = $1 AND contact.id IN (mapping.winner_id, mapping.loser_id)
           GROUP BY mapping.winner_id
         )
         UPDATE contacts winner SET first_observed_at = aggregates.first_observed_at,
           last_observed_at = aggregates.last_observed_at, updated_at = now()
         FROM aggregates WHERE winner.session_id = $1 AND winner.id = aggregates.winner_id`,
        [sessionId],
      );
      await client.query(
        `DELETE FROM contacts contact USING ${mappingRelation}
         WHERE contact.session_id = $1 AND contact.id = mapping.loser_id`,
        [sessionId],
      );
      await client.query(
        `WITH affected AS MATERIALIZED (
           SELECT DISTINCT winner_id AS contact_id FROM contact_merge_plan
         ), effective AS MATERIALIZED (
           SELECT affected.contact_id,
             ${contactProjection.name} AS name_value,
             ${contactProjection.source} AS name_source
           FROM affected
           LEFT JOIN contact_names contact_source ON contact_source.session_id = $1
             AND contact_source.contact_id = affected.contact_id AND contact_source.name_source = 'OPENWA_CONTACT_NAME'
           LEFT JOIN contact_names push_source ON push_source.session_id = $1
             AND push_source.contact_id = affected.contact_id AND push_source.name_source = 'OPENWA_PUSH_NAME'
         )
         UPDATE contacts contact SET effective_display_name = effective.name_value,
           display_name_source = effective.name_source, updated_at = now()
         FROM effective WHERE contact.session_id = $1 AND contact.id = effective.contact_id`,
        [sessionId],
      );
      const result = await client.query<{ merged: string; conflicts: string; enriched: string }>(
        `WITH affected AS MATERIALIZED (
           SELECT DISTINCT winner_id AS contact_id FROM contact_merge_plan
         ), member_writes AS (
           UPDATE group_members member SET display_name = ${memberProjection.name},
             display_name_source = ${memberProjection.source},
             display_name_updated_at = CASE WHEN ${memberProjection.name} IS NULL THEN NULL ELSE now() END,
             updated_at = now()
           FROM contacts contact, affected
           WHERE contact.session_id = $1 AND contact.id = affected.contact_id
             AND member.session_id = $1 AND member.contact_id = contact.id
             AND $3::boolean
             AND (member.display_name, member.display_name_source)
               IS DISTINCT FROM (${memberProjection.name}, ${memberProjection.source})
           RETURNING member.contact_id
         ), ambiguous AS (
           SELECT evidence.phone
           FROM contact_identity_evidence evidence
           WHERE evidence.session_id = $1 AND evidence.sync_generation = $2
           GROUP BY evidence.phone
           HAVING count(DISTINCT (evidence.identity_type, evidence.identity_value)) > 1
         )
         SELECT (SELECT count(*) FROM contact_merge_plan)::text AS merged,
           (SELECT count(*) FROM contact_identity_evidence evidence JOIN ambiguous USING (phone)
             WHERE evidence.session_id = $1 AND evidence.sync_generation = $2)::text AS conflicts,
           (SELECT count(*) FROM member_writes)::text AS enriched`,
        [sessionId, generation, this.legacyMemberFanoutEnabled],
      );
      await client.query(
        `DELETE FROM contact_identity_evidence WHERE session_id = $1 AND sync_generation <= $2`,
        [sessionId, generation],
      );
      return {
        merged: Number(result.rows[0]?.merged ?? 0),
        conflicts: Number(result.rows[0]?.conflicts ?? 0),
        enriched: Number(result.rows[0]?.enriched ?? 0),
      };
    });
  }

  async completeObservedSnapshot(
    sessionId: string,
    generation: number,
    leaseToken: string,
    records: number,
    intervalMs: number,
  ): Promise<void> {
    const completionSql = `UPDATE contact_sync_state SET last_completed_at = now(), last_successful_record_count = $3,
         last_error_code = NULL, attempt_count = 0,
         next_attempt_at = now() + $5 * interval '1 millisecond',
         lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE session_id = $1 AND sync_generation = $2 AND lease_token = $4
         AND lease_expires_at > now()`;
    const values = [sessionId, generation, records, leaseToken, intervalMs];
    if (!this.snapshotStagingEnabled) {
      const result = await this.database.query(completionSql, values);
      if (result.rowCount !== 1) throw new Error('Contact snapshot lost write ownership');
      return;
    }
    await this.database.transaction(async client => {
      const ownership = await client.query(
        `SELECT 1 FROM contact_sync_state
         WHERE session_id = $1 AND sync_generation = $2 AND lease_token = $3
           AND lease_expires_at > now()
         FOR UPDATE`,
        [sessionId, generation, leaseToken],
      );
      if (ownership.rowCount !== 1) throw new Error('Contact snapshot lost write ownership');
      await this.evidenceWriter.publishSnapshot(client, sessionId, generation);
      const generationResult = await client.query(
        `UPDATE contact_snapshot_generations generation_state
         SET state = 'PUBLISHED',
           upstream_record_count = $3,
           staged_identity_count = (
             SELECT count(*) FROM contact_snapshot_observations observation
             WHERE observation.session_id = $1 AND observation.generation = $2
           ),
           published_at = now(), updated_at = now()
         WHERE generation_state.session_id = $1 AND generation_state.generation = $2
           AND generation_state.state = 'RECEIVING' AND generation_state.lease_token = $4`,
        values.slice(0, 4),
      );
      if (generationResult.rowCount !== 1) throw new Error('Contact snapshot lost publication ownership');
      const completion = await client.query(completionSql, values);
      if (completion.rowCount !== 1) throw new Error('Contact snapshot lost write ownership');
    });
  }

  async failObservedSnapshot(sessionId: string, generation: number, leaseToken: string, code: string): Promise<void> {
    const failureSql = `WITH evidence_cleanup AS (
         DELETE FROM contact_identity_evidence WHERE session_id = $1 AND sync_generation = $2
       )
       UPDATE contact_sync_state SET last_error_code = $4,
         next_attempt_at = now() + LEAST(3600, 60 * power(2, LEAST(attempt_count, 6))) * interval '1 second',
         lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE session_id = $1 AND sync_generation = $2 AND lease_token = $3`;
    const values = [sessionId, generation, leaseToken, code];
    if (!this.snapshotStagingEnabled) {
      await this.database.query(failureSql, values);
      return;
    }
    await this.database.transaction(async client => {
      await client.query(
        `UPDATE contact_snapshot_generations
         SET state = 'FAILED', failed_at = now(), error_code = $4, updated_at = now()
         WHERE session_id = $1 AND generation = $2 AND lease_token = $3
           AND state = 'RECEIVING'`,
        values,
      );
      await client.query(failureSql, values);
    });
  }

  async observeMessageSender(
    sessionId: string,
    rawIdentity: string,
    rawPushName: string | null | undefined,
    observedAt: Date,
    observationKey: string,
  ): Promise<boolean> {
    const identity = normalizeContactIdentity(rawIdentity);
    if (identity.type !== 'LID' && identity.type !== 'PHONE_JID') return false;
    const pushName = normalizeContactName(rawPushName, identity);
    if (!pushName) return false;
    const candidateContactId = randomUUID();
    return this.database.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [sessionId]);
      await client.query(
        `WITH existing AS MATERIALIZED (
           SELECT contact_id FROM contact_identifiers
           WHERE session_id = $1 AND identity_type = $2 AND identity_value = $3
         ), created AS (
           INSERT INTO contacts (session_id, id)
           SELECT $1, $4 WHERE NOT EXISTS (SELECT 1 FROM existing)
           ON CONFLICT DO NOTHING
         )
         INSERT INTO contact_identifiers
           (session_id, contact_id, identity_type, identity_value, mapping_source)
         SELECT $1, COALESCE((SELECT contact_id FROM existing), $4), $2, $3, 'MESSAGE_IDENTITY'
         ON CONFLICT (session_id, identity_type, identity_value) DO UPDATE SET
           last_observed_at = now(), updated_at = now()`,
        [sessionId, identity.type, identity.value, candidateContactId],
      );
      await this.evidenceWriter.observeMessageSender(
        client,
        sessionId,
        {
          identity_type: identity.type,
          identity_value: identity.value,
          phone: identity.phone,
        },
        pushName,
        observedAt,
        observationKey,
      );
      const result = await client.query<{ accepted: boolean }>(
        `WITH resolved AS MATERIALIZED (
           SELECT contact_id FROM contact_identifiers
           WHERE session_id = $1 AND identity_type = $2 AND identity_value = $3
         ), name_write AS (
           INSERT INTO contact_names
             (session_id, contact_id, name_source, name_value,
              source_observed_at, source_observation_key)
           SELECT $1, contact_id, 'OPENWA_PUSH_NAME', $4, $5, $6 FROM resolved
           ON CONFLICT (session_id, contact_id, name_source) DO UPDATE SET
             name_value = EXCLUDED.name_value,
             source_observed_at = EXCLUDED.source_observed_at,
             source_observation_key = EXCLUDED.source_observation_key,
             last_observed_at = now(), updated_at = now()
           WHERE (contact_names.source_observed_at, contact_names.source_observation_key)
             < (EXCLUDED.source_observed_at, EXCLUDED.source_observation_key)
           RETURNING contact_id, name_value
         ), effective AS MATERIALIZED (
           SELECT name_write.contact_id,
             ${observedContactProjection.name} AS name_value,
             ${observedContactProjection.source} AS name_source
           FROM name_write
           LEFT JOIN contact_names contact_source ON contact_source.session_id = $1
             AND contact_source.contact_id = name_write.contact_id
             AND contact_source.name_source = 'OPENWA_CONTACT_NAME'
         ), contact_write AS (
           UPDATE contacts contact SET
             effective_display_name = effective.name_value,
             display_name_source = effective.name_source,
             last_observed_at = now(), updated_at = now()
           FROM effective WHERE contact.session_id = $1 AND contact.id = effective.contact_id
           RETURNING contact.id, contact.effective_display_name, contact.display_name_source
         )
         , member_write AS (
           UPDATE group_members member SET display_name = ${observedMemberProjection.name},
             display_name_source = ${observedMemberProjection.source},
             display_name_updated_at = CASE WHEN ${observedMemberProjection.name} IS NULL
               THEN NULL ELSE now() END,
             updated_at = now()
           FROM contact_write WHERE member.session_id = $1 AND member.contact_id = contact_write.id
             AND $7::boolean
             AND (member.display_name, member.display_name_source)
               IS DISTINCT FROM (${observedMemberProjection.name}, ${observedMemberProjection.source})
           RETURNING member.contact_id
         )
         SELECT EXISTS (SELECT 1 FROM name_write) AS accepted`,
        [sessionId, identity.type, identity.value, pushName, observedAt, observationKey,
          this.legacyMemberFanoutEnabled],
      );
      return result.rows[0]?.accepted ?? false;
    });
  }

  async seedGroupMembers(
    client: PoolClient,
    sessionId: string,
    groupId: string,
    participants: OpenWAGroupParticipant[],
  ): Promise<void> {
    if (participants.length === 0) return;
    const candidates = new Map<string, string>();
    const inputs: GroupMemberContactInput[] = participants.map(participant => {
      const identity = normalizeContactIdentity(participant.id);
      const identityKey = `${identity.type}\0${identity.value}`;
      const candidateContactId = candidates.get(identityKey) ?? randomUUID();
      candidates.set(identityKey, candidateContactId);
      return {
        participant_id: participant.id,
        identity_type: identity.type,
        identity_value: identity.value,
        phone: identity.phone,
        participant_name: normalizeContactName(participant.name, identity),
        candidate_contact_id: candidateContactId,
      };
    });
    const values = [sessionId, groupId, JSON.stringify(inputs)];

    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [sessionId]);
    await this.evidenceWriter.observeGroupMembers(client, sessionId, groupId, inputs);
    await client.query(
      `WITH input AS MATERIALIZED (SELECT * FROM ${inputRelation} WHERE $2::text IS NOT NULL),
       missing AS MATERIALIZED (
         SELECT DISTINCT ON (input.identity_type, input.identity_value) input.*
         FROM input
         LEFT JOIN contact_identifiers identifier
           ON identifier.session_id = $1 AND identifier.identity_type = input.identity_type
          AND identifier.identity_value = input.identity_value
         WHERE identifier.contact_id IS NULL
         ORDER BY input.identity_type, input.identity_value, input.participant_id
       ), created AS (
         INSERT INTO contacts (session_id, id)
         SELECT $1, missing.candidate_contact_id FROM missing
         ON CONFLICT DO NOTHING
       )
         INSERT INTO contact_identifiers
           (session_id, contact_id, identity_type, identity_value, mapping_source)
         SELECT $1, missing.candidate_contact_id, missing.identity_type,
           missing.identity_value, 'GROUP_PARTICIPANT'
         FROM missing
         ON CONFLICT (session_id, identity_type, identity_value) DO UPDATE SET
           last_observed_at = now(), updated_at = now()`,
      values,
    );

    await client.query(
      `WITH input AS MATERIALIZED (SELECT * FROM ${inputRelation} WHERE $2::text IS NOT NULL),
       touched AS (
         UPDATE contact_identifiers identifier
         SET last_observed_at = now(), updated_at = now()
         FROM input
         WHERE identifier.session_id = $1 AND identifier.identity_type = input.identity_type
           AND identifier.identity_value = input.identity_value
         RETURNING identifier.contact_id
       )
       INSERT INTO contact_identifiers
         (session_id, contact_id, identity_type, identity_value, mapping_source)
       SELECT DISTINCT $1, identifier.contact_id, 'PHONE', input.phone, 'GROUP_PARTICIPANT'
       FROM input
       JOIN contact_identifiers identifier
         ON identifier.session_id = $1 AND identifier.identity_type = input.identity_type
        AND identifier.identity_value = input.identity_value
       WHERE input.identity_type = 'PHONE_JID' AND input.phone IS NOT NULL
       ON CONFLICT (session_id, identity_type, identity_value) DO UPDATE SET
         last_observed_at = now(), updated_at = now()`,
      values,
    );

    await client.query(
      `WITH input AS MATERIALIZED (SELECT * FROM ${inputRelation}),
       resolved AS MATERIALIZED (
         SELECT input.*, identifier.contact_id, contact.effective_display_name,
           contact.display_name_source AS contact_name_source,
           evidence_identity.id AS evidence_identity_id
         FROM input
         JOIN contact_identifiers identifier
           ON identifier.session_id = $1 AND identifier.identity_type = input.identity_type
          AND identifier.identity_value = input.identity_value
         JOIN contacts contact ON contact.session_id = $1 AND contact.id = identifier.contact_id
         LEFT JOIN observed_contact_identities evidence_identity
           ON evidence_identity.session_id = $1
          AND evidence_identity.identity_type = input.identity_type
          AND evidence_identity.identity_value = input.identity_value
       )
       UPDATE group_members member
       SET contact_id = resolved.contact_id,
           evidence_identity_id = resolved.evidence_identity_id,
           identity_type = resolved.identity_type,
           resolved_phone_number = CASE WHEN resolved.identity_type = 'PHONE_JID'
             THEN resolved.phone ELSE NULL END,
           participant_display_name = resolved.participant_name,
           display_name = CASE WHEN $4::boolean
             THEN ${resolvedMemberProjection.name} ELSE member.display_name END,
           display_name_source = CASE WHEN $4::boolean
             THEN ${resolvedMemberProjection.source} ELSE member.display_name_source END,
           display_name_updated_at = CASE WHEN NOT $4::boolean THEN member.display_name_updated_at
             WHEN ${resolvedMemberProjection.name} IS NULL THEN NULL ELSE now() END,
           updated_at = now()
       FROM resolved
       WHERE member.session_id = $1 AND member.group_id = $2
         AND member.participant_id = resolved.participant_id
         AND (member.contact_id, member.evidence_identity_id, member.identity_type,
              member.resolved_phone_number, member.participant_display_name,
              member.display_name, member.display_name_source)
           IS DISTINCT FROM
           (resolved.contact_id, resolved.evidence_identity_id, resolved.identity_type,
            CASE WHEN resolved.identity_type = 'PHONE_JID' THEN resolved.phone ELSE NULL END,
            resolved.participant_name,
            CASE WHEN $4::boolean THEN ${resolvedMemberProjection.name} ELSE member.display_name END,
            CASE WHEN $4::boolean THEN ${resolvedMemberProjection.source}
              ELSE member.display_name_source END)`,
      [...values, this.legacyMemberFanoutEnabled],
    );
  }
}
