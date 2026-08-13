import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { OpenWAGroupParticipant } from '../../integrations/openwa/openwa.client';
import type { OpenWAContact } from '../../integrations/openwa/openwa.client';
import { normalizeContactIdentity, normalizeContactName } from './contact-normalization';
import { DatabaseService } from '../../core/database/database.service';

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

@Injectable()
export class ContactRepository {
  constructor(private readonly database: DatabaseService) {}

  async beginObservedSnapshot(sessionId: string): Promise<number> {
    const result = await this.database.query<{ sync_generation: string }>(
      `INSERT INTO contact_sync_state (session_id, sync_generation, last_started_at, last_error_code)
       VALUES ($1, 1, now(), NULL)
       ON CONFLICT (session_id) DO UPDATE SET
         sync_generation = contact_sync_state.sync_generation + 1,
         last_started_at = now(), last_error_code = NULL, updated_at = now()
       RETURNING sync_generation`,
      [sessionId],
    );
    return Number(result.rows[0]!.sync_generation);
  }

  async ingestObservedPage(sessionId: string, contacts: OpenWAContact[]): Promise<{
    observed: number;
    enriched: number;
    conflicts: number;
  }> {
    if (contacts.length === 0) return { observed: 0, enriched: 0, conflicts: 0 };
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
      const pageJson = JSON.stringify(rows);
      const pageRelation = `jsonb_to_recordset($2::jsonb) AS contact(
        identity_type text, identity_value text, phone text, contact_name text,
        push_name text, candidate_contact_id uuid
      )`;
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
         SELECT DISTINCT $1, matched.contact_id, 'PHONE', matched.phone, 'OPENWA_CONTACT_PHONE'
         FROM matched WHERE matched.phone IS NOT NULL
           AND (matched.phone_contact_id IS NULL OR matched.phone_contact_id = matched.contact_id)
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
           INSERT INTO contact_names (session_id, contact_id, name_source, name_value)
           SELECT DISTINCT ON (matched.contact_id)
             $1, matched.contact_id, 'OPENWA_CONTACT_NAME', matched.contact_name
           FROM matched WHERE matched.contact_name IS NOT NULL
           ORDER BY matched.contact_id, matched.identity_value
           ON CONFLICT (session_id, contact_id, name_source) DO UPDATE SET
             name_value = EXCLUDED.name_value, last_observed_at = now(), updated_at = now()
         )
         INSERT INTO contact_names (session_id, contact_id, name_source, name_value)
         SELECT DISTINCT ON (matched.contact_id)
           $1, matched.contact_id, 'OPENWA_PUSH_NAME', matched.push_name
         FROM matched WHERE matched.push_name IS NOT NULL
         ORDER BY matched.contact_id, matched.identity_value
         ON CONFLICT (session_id, contact_id, name_source) DO UPDATE SET
           name_value = EXCLUDED.name_value, last_observed_at = now(), updated_at = now()`,
        [sessionId, pageJson],
      );
      await client.query(
        `WITH affected AS MATERIALIZED (
           SELECT DISTINCT identifier.contact_id FROM ${pageRelation}
           JOIN contact_identifiers identifier
             ON identifier.session_id = $1 AND identifier.identity_type = contact.identity_type
            AND identifier.identity_value = contact.identity_value
         ), effective AS MATERIALIZED (
           SELECT affected.contact_id,
             COALESCE(contact_source.name_value, participant_source.name_value, push_source.name_value) AS name_value,
             CASE
               WHEN contact_source.name_value IS NOT NULL THEN 'OPENWA_CONTACT_NAME'
               WHEN participant_source.name_value IS NOT NULL THEN 'GROUP_PARTICIPANT_NAME'
               WHEN push_source.name_value IS NOT NULL THEN 'OPENWA_PUSH_NAME'
               ELSE NULL
             END AS name_source
           FROM affected
           LEFT JOIN contact_names contact_source ON contact_source.session_id = $1
             AND contact_source.contact_id = affected.contact_id AND contact_source.name_source = 'OPENWA_CONTACT_NAME'
           LEFT JOIN contact_names participant_source ON participant_source.session_id = $1
             AND participant_source.contact_id = affected.contact_id AND participant_source.name_source = 'GROUP_PARTICIPANT_NAME'
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
      const result = await client.query<{ enriched: string; conflicts: string }>(
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
           UPDATE group_members member SET display_name = contact.effective_display_name,
             display_name_source = contact.display_name_source,
             display_name_updated_at = CASE WHEN contact.effective_display_name IS NULL THEN NULL ELSE now() END,
             updated_at = now()
           FROM contacts contact, affected
           WHERE contact.session_id = $1 AND contact.id = affected.contact_id
             AND member.session_id = $1 AND member.contact_id = contact.id
             AND (member.display_name, member.display_name_source)
               IS DISTINCT FROM (contact.effective_display_name, contact.display_name_source)
           RETURNING member.contact_id
         )
         SELECT (SELECT count(*) FROM member_writes)::text AS enriched,
           (SELECT count(*) FROM affected WHERE phone IS NOT NULL AND phone_contact_id IS NOT NULL
             AND phone_contact_id <> contact_id)::text AS conflicts`,
        [sessionId, pageJson],
      );
      return {
        observed: rows.length,
        enriched: Number(result.rows[0]?.enriched ?? 0),
        conflicts: Number(result.rows[0]?.conflicts ?? 0),
      };
    });
  }

  async completeObservedSnapshot(sessionId: string, generation: number, records: number): Promise<void> {
    await this.database.query(
      `UPDATE contact_sync_state SET last_completed_at = now(), last_successful_record_count = $3,
         last_error_code = NULL, updated_at = now()
       WHERE session_id = $1 AND sync_generation = $2`,
      [sessionId, generation, records],
    );
  }

  async failObservedSnapshot(sessionId: string, generation: number, code: string): Promise<void> {
    await this.database.query(
      `UPDATE contact_sync_state SET last_error_code = $3, updated_at = now()
       WHERE session_id = $1 AND sync_generation = $2`,
      [sessionId, generation, code],
    );
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
      `WITH input AS MATERIALIZED (SELECT * FROM ${inputRelation} WHERE $2::text IS NOT NULL),
       name_writes AS (
         INSERT INTO contact_names (session_id, contact_id, name_source, name_value)
         SELECT DISTINCT ON (identifier.contact_id)
           $1, identifier.contact_id, 'GROUP_PARTICIPANT_NAME', input.participant_name
         FROM input
         JOIN contact_identifiers identifier
           ON identifier.session_id = $1 AND identifier.identity_type = input.identity_type
          AND identifier.identity_value = input.identity_value
         WHERE input.participant_name IS NOT NULL
         ORDER BY identifier.contact_id, input.participant_id
         ON CONFLICT (session_id, contact_id, name_source) DO UPDATE SET
           name_value = EXCLUDED.name_value, last_observed_at = now(), updated_at = now()
         RETURNING contact_id, name_value
       )
       UPDATE contacts contact
       SET effective_display_name = names.name_value,
           display_name_source = 'GROUP_PARTICIPANT_NAME',
           last_observed_at = now(), updated_at = now()
       FROM name_writes names
       WHERE contact.session_id = $1 AND contact.id = names.contact_id
         AND (contact.display_name_source IS NULL OR contact.display_name_source = 'GROUP_PARTICIPANT_NAME')
         AND (contact.effective_display_name, contact.display_name_source)
           IS DISTINCT FROM (names.name_value, 'GROUP_PARTICIPANT_NAME')`,
      values,
    );

    await client.query(
      `WITH input AS MATERIALIZED (SELECT * FROM ${inputRelation}),
       resolved AS MATERIALIZED (
         SELECT input.*, identifier.contact_id, contact.effective_display_name,
           contact.display_name_source AS contact_name_source
         FROM input
         JOIN contact_identifiers identifier
           ON identifier.session_id = $1 AND identifier.identity_type = input.identity_type
          AND identifier.identity_value = input.identity_value
         JOIN contacts contact ON contact.session_id = $1 AND contact.id = identifier.contact_id
       )
       UPDATE group_members member
       SET contact_id = resolved.contact_id,
           participant_display_name = resolved.participant_name,
           display_name = CASE
             WHEN resolved.contact_name_source = 'OPENWA_CONTACT_NAME' THEN resolved.effective_display_name
             WHEN resolved.participant_name IS NOT NULL THEN resolved.participant_name
             ELSE resolved.effective_display_name
           END,
           display_name_source = CASE
             WHEN resolved.contact_name_source = 'OPENWA_CONTACT_NAME' THEN resolved.contact_name_source
             WHEN resolved.participant_name IS NOT NULL THEN 'GROUP_PARTICIPANT_NAME'
             ELSE resolved.contact_name_source
           END,
           display_name_updated_at = CASE
             WHEN COALESCE(resolved.effective_display_name, resolved.participant_name) IS NULL THEN NULL
             ELSE now()
           END,
           updated_at = now()
       FROM resolved
       WHERE member.session_id = $1 AND member.group_id = $2
         AND member.participant_id = resolved.participant_id
         AND (member.contact_id, member.participant_display_name, member.display_name, member.display_name_source)
           IS DISTINCT FROM
           (resolved.contact_id, resolved.participant_name,
            CASE
              WHEN resolved.contact_name_source = 'OPENWA_CONTACT_NAME' THEN resolved.effective_display_name
              WHEN resolved.participant_name IS NOT NULL THEN resolved.participant_name
              ELSE resolved.effective_display_name
            END,
            CASE
              WHEN resolved.contact_name_source = 'OPENWA_CONTACT_NAME' THEN resolved.contact_name_source
              WHEN resolved.participant_name IS NOT NULL THEN 'GROUP_PARTICIPANT_NAME'
              ELSE resolved.contact_name_source
            END)`,
      values,
    );
  }
}
