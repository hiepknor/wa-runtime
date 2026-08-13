import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { OpenWAGroupParticipant } from '../../integrations/openwa/openwa.client';
import { normalizeContactIdentity, normalizeContactName } from './contact-normalization';

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
