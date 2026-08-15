import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { OpenWAGroupParticipant } from '../../integrations/openwa/openwa.client';
import { DatabaseService } from '../../core/database/database.service';
import { ContactEvidenceWriter } from './contact-evidence.writer';
import { contactNameProjectionSql, memberNameProjectionSql } from './contact-name-resolution.sql';
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

const observedContactProjection = contactNameProjectionSql({
  contactName: 'contact_source.name_value',
  pushName: 'name_write.name_value',
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

export class ContactObservationRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly evidenceWriter: ContactEvidenceWriter,
    private readonly legacyMemberFanoutEnabled: boolean,
  ) {}

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
