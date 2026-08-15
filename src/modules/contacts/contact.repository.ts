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
import { ContactSnapshotLifecycleRepository } from './contact-snapshot-lifecycle.repository';
import { ContactObservationRepository } from './contact-observation.repository';
import { ContactSyncQueryRepository } from './contact-sync-query.repository';

const contactProjection = contactNameProjectionSql({
  contactName: 'contact_source.name_value',
  pushName: 'push_source.name_value',
});
const memberProjection = memberNameProjectionSql({
  contactName: 'contact.effective_display_name',
  contactSource: 'contact.display_name_source',
  participantName: 'member.participant_display_name',
});
@Injectable()
export class ContactRepository {
  private readonly snapshotLifecycle: ContactSnapshotLifecycleRepository;
  private readonly observations: ContactObservationRepository;
  private readonly queries: ContactSyncQueryRepository;

  constructor(
    private readonly database: DatabaseService,
    private readonly snapshotStagingEnabled = false,
    snapshotRetentionDays = 30,
    evidenceWriter = new ContactEvidenceWriter(false),
    private readonly legacyMemberFanoutEnabled = true,
  ) {
    this.snapshotLifecycle = new ContactSnapshotLifecycleRepository(
      database,
      snapshotStagingEnabled,
      snapshotRetentionDays,
      evidenceWriter,
    );
    this.observations = new ContactObservationRepository(
      database,
      evidenceWriter,
      legacyMemberFanoutEnabled,
    );
    this.queries = new ContactSyncQueryRepository(database);
  }

  async listPeriodicSessionIds(allowedSessionIds: string[], limit: number): Promise<string[]> {
    return this.queries.listPeriodicSessionIds(allowedSessionIds, limit);
  }

  async getCoverageMetrics(sessionId: string): Promise<Record<string, number>> {
    return this.queries.getCoverageMetrics(sessionId);
  }

  async beginObservedSnapshot(sessionId: string, force = true): Promise<{
    generation: number;
    leaseToken: string;
  } | null> {
    return this.snapshotLifecycle.begin(sessionId, force);
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
    return this.snapshotLifecycle.complete(sessionId, generation, leaseToken, records, intervalMs);
  }

  async failObservedSnapshot(sessionId: string, generation: number, leaseToken: string, code: string): Promise<void> {
    return this.snapshotLifecycle.fail(sessionId, generation, leaseToken, code);
  }

  async observeMessageSender(
    sessionId: string,
    rawIdentity: string,
    rawPushName: string | null | undefined,
    observedAt: Date,
    observationKey: string,
  ): Promise<boolean> {
    return this.observations.observeMessageSender(
      sessionId,
      rawIdentity,
      rawPushName,
      observedAt,
      observationKey,
    );
  }

  async seedGroupMembers(
    client: PoolClient,
    sessionId: string,
    groupId: string,
    participants: OpenWAGroupParticipant[],
  ): Promise<void> {
    return this.observations.seedGroupMembers(client, sessionId, groupId, participants);
  }
}
