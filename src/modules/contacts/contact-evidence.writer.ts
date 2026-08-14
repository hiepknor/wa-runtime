import type { PoolClient } from 'pg';
import { enqueueContactProjectionWork } from './contact-projection.enqueue';

export interface ContactEvidenceIdentityInput {
  identity_type: 'LID' | 'PHONE_JID' | 'OTHER_JID';
  identity_value: string;
  phone: string | null;
  participant_id?: string;
  participant_name?: string | null;
}

const evidenceInputRelation = `jsonb_to_recordset($2::jsonb) AS evidence(
  identity_type text, identity_value text, phone text,
  participant_id text, participant_name text
)`;

export class ContactEvidenceWriter {
  constructor(
    readonly enabled: boolean,
    private readonly projectionEnabled = false,
  ) {}

  async observeGroupMembers(
    client: PoolClient,
    sessionId: string,
    groupId: string,
    inputs: ContactEvidenceIdentityInput[],
  ): Promise<void> {
    if (!this.enabled || inputs.length === 0) return;
    const values = [sessionId, JSON.stringify(inputs), groupId];
    await this.upsertInputIdentities(client, values);
    await client.query(
      `WITH input AS MATERIALIZED (SELECT * FROM ${evidenceInputRelation})
       INSERT INTO contact_observations
         (session_id, identity_id, observation_source, observation_scope,
          group_id, participant_id, name_value, source_observed_at, source_observation_key)
       SELECT $1, identity.id, 'GROUP_PARTICIPANT_NAME', 'MEMBERSHIP',
         $3, input.participant_id, input.participant_name, now(),
         'group:' || md5($3 || ':' || input.participant_id || ':' || input.participant_name)
       FROM input
       JOIN observed_contact_identities identity
         ON identity.session_id = $1 AND identity.identity_type = input.identity_type
        AND identity.identity_value = input.identity_value
       WHERE input.participant_name IS NOT NULL
       ON CONFLICT (session_id, observation_source, source_observation_key) DO NOTHING`,
      values,
    );
    await this.insertInputLinks(client, values, null);
    if (this.projectionEnabled) {
      const identities = await this.inputIdentityIds(client, values);
      await enqueueContactProjectionWork(client, sessionId, identities);
    }
  }

  async observeMessageSender(
    client: PoolClient,
    sessionId: string,
    input: ContactEvidenceIdentityInput,
    pushName: string,
    observedAt: Date,
    observationKey: string,
  ): Promise<void> {
    if (!this.enabled) return;
    const values = [sessionId, JSON.stringify([input])];
    await this.upsertInputIdentities(client, values);
    const observation = await client.query<{ identity_id: string }>(
      `WITH input AS MATERIALIZED (SELECT * FROM ${evidenceInputRelation}),
       identity AS MATERIALIZED (
         SELECT observed.id FROM input
         JOIN observed_contact_identities observed
           ON observed.session_id = $1 AND observed.identity_type = input.identity_type
          AND observed.identity_value = input.identity_value
       ), previous AS MATERIALIZED (
         SELECT existing.id, existing.name_value, existing.source_observed_at,
           existing.source_observation_key
         FROM contact_observations existing JOIN identity ON identity.id = existing.identity_id
         WHERE existing.session_id = $1 AND existing.observation_source = 'OPENWA_PUSH_NAME'
         ORDER BY existing.source_observed_at DESC,
           existing.source_observation_key DESC, existing.id DESC LIMIT 1
       ), inserted AS (
         INSERT INTO contact_observations
           (session_id, identity_id, observation_source, observation_scope,
            name_value, source_observed_at, source_observation_key)
         SELECT $1, identity.id, 'OPENWA_PUSH_NAME', 'IDENTITY', $3, $4, $5 FROM identity
         ON CONFLICT (session_id, observation_source, source_observation_key) DO NOTHING
         RETURNING id, identity_id, name_value, source_observed_at, source_observation_key
       )
       SELECT inserted.identity_id FROM inserted LEFT JOIN previous ON true
       WHERE previous.id IS NULL OR (
         (inserted.source_observed_at, inserted.source_observation_key, inserted.id)
           > (previous.source_observed_at, previous.source_observation_key, previous.id)
         AND inserted.name_value IS DISTINCT FROM previous.name_value
       )`,
      [sessionId, JSON.stringify([input]), pushName, observedAt, observationKey],
    );
    await this.insertInputLinks(client, values, null);
    if (this.projectionEnabled && observation.rows[0]) {
      await enqueueContactProjectionWork(client, sessionId, [observation.rows[0].identity_id]);
    }
  }

  async publishSnapshot(client: PoolClient, sessionId: string, generation: number): Promise<void> {
    if (!this.enabled) return;
    await client.query(
      `INSERT INTO observed_contact_identities
         (session_id, identity_type, identity_value, first_observed_at, last_observed_at)
       SELECT observation.session_id, observation.identity_type, observation.identity_value,
         observation.source_observed_at, observation.source_observed_at
       FROM contact_snapshot_observations observation
       WHERE observation.session_id = $1 AND observation.generation = $2
       ON CONFLICT (session_id, identity_type, identity_value) DO UPDATE SET
         first_observed_at = LEAST(
           observed_contact_identities.first_observed_at,
           EXCLUDED.first_observed_at
         ),
         last_observed_at = GREATEST(
           observed_contact_identities.last_observed_at,
           EXCLUDED.last_observed_at
         ),
         updated_at = now()`,
      [sessionId, generation],
    );
    await client.query(
      `INSERT INTO observed_contact_identities
         (session_id, identity_type, identity_value, first_observed_at, last_observed_at)
       SELECT DISTINCT ON (observation.session_id, observation.phone)
         observation.session_id, 'PHONE', observation.phone,
         observation.source_observed_at, observation.source_observed_at
       FROM contact_snapshot_observations observation
       WHERE observation.session_id = $1 AND observation.generation = $2
         AND observation.phone IS NOT NULL
       ORDER BY observation.session_id, observation.phone,
         observation.source_observed_at DESC, observation.identity_type, observation.identity_value
       ON CONFLICT (session_id, identity_type, identity_value) DO UPDATE SET
         first_observed_at = LEAST(
           observed_contact_identities.first_observed_at,
           EXCLUDED.first_observed_at
         ),
         last_observed_at = GREATEST(
           observed_contact_identities.last_observed_at,
           EXCLUDED.last_observed_at
         ),
         updated_at = now()`,
      [sessionId, generation],
    );
    await client.query(
      `INSERT INTO contact_observations
         (session_id, identity_id, observation_source, observation_scope, name_value,
          source_generation, source_observed_at, source_observation_key)
       SELECT observation.session_id, identity.id, source.observation_source, 'IDENTITY',
         source.name_value, observation.generation, observation.source_observed_at,
         observation.source_observation_key || ':' || source.observation_source
       FROM contact_snapshot_observations observation
       JOIN observed_contact_identities identity
         ON identity.session_id = observation.session_id
        AND identity.identity_type = observation.identity_type
        AND identity.identity_value = observation.identity_value
       CROSS JOIN LATERAL (VALUES
         ('OPENWA_CONTACT_NAME', observation.contact_name),
         ('OPENWA_PUSH_NAME', observation.push_name)
       ) AS source(observation_source, name_value)
       WHERE observation.session_id = $1 AND observation.generation = $2
         AND source.name_value IS NOT NULL
       ON CONFLICT (session_id, observation_source, source_observation_key) DO NOTHING`,
      [sessionId, generation],
    );
    await client.query(
      `INSERT INTO contact_link_evidence
         (session_id, left_identity_id, right_identity_id, evidence_source,
          source_generation, source_observed_at, source_observation_key)
       SELECT observation.session_id, source_identity.id, phone_identity.id,
         CASE WHEN observation.identity_type = 'PHONE_JID'
           THEN 'PHONE_JID_DERIVATION' ELSE 'OPENWA_CONTACT_PHONE' END,
         observation.generation, observation.source_observed_at,
         observation.source_observation_key || ':phone'
       FROM contact_snapshot_observations observation
       JOIN observed_contact_identities source_identity
         ON source_identity.session_id = observation.session_id
        AND source_identity.identity_type = observation.identity_type
        AND source_identity.identity_value = observation.identity_value
       JOIN observed_contact_identities phone_identity
         ON phone_identity.session_id = observation.session_id
        AND phone_identity.identity_type = 'PHONE'
        AND phone_identity.identity_value = observation.phone
       WHERE observation.session_id = $1 AND observation.generation = $2
         AND observation.phone IS NOT NULL
       ON CONFLICT (session_id, evidence_source, source_observation_key) DO NOTHING`,
      [sessionId, generation],
    );
  }

  private async upsertInputIdentities(client: PoolClient, values: unknown[]): Promise<void> {
    await client.query(
      `WITH input AS MATERIALIZED (SELECT * FROM ${evidenceInputRelation}),
       exact_writes AS (
         INSERT INTO observed_contact_identities (session_id, identity_type, identity_value)
         SELECT DISTINCT $1, input.identity_type, input.identity_value FROM input
         ON CONFLICT (session_id, identity_type, identity_value) DO UPDATE SET
           last_observed_at = now(), updated_at = now()
       )
       INSERT INTO observed_contact_identities (session_id, identity_type, identity_value)
       SELECT DISTINCT $1, 'PHONE', input.phone FROM input WHERE input.phone IS NOT NULL
       ON CONFLICT (session_id, identity_type, identity_value) DO UPDATE SET
         last_observed_at = now(), updated_at = now()`,
      values.slice(0, 2),
    );
  }

  private async insertInputLinks(
    client: PoolClient,
    values: unknown[],
    generation: number | null,
  ): Promise<void> {
    await client.query(
      `WITH input AS MATERIALIZED (SELECT * FROM ${evidenceInputRelation})
       INSERT INTO contact_link_evidence
         (session_id, left_identity_id, right_identity_id, evidence_source,
          source_generation, source_observed_at, source_observation_key)
       SELECT $1, source_identity.id, phone_identity.id, 'PHONE_JID_DERIVATION',
         $3::bigint, now(),
         'derived:' || md5(input.identity_value || ':' || input.phone)
       FROM input
       JOIN observed_contact_identities source_identity
         ON source_identity.session_id = $1 AND source_identity.identity_type = input.identity_type
        AND source_identity.identity_value = input.identity_value
       JOIN observed_contact_identities phone_identity
         ON phone_identity.session_id = $1 AND phone_identity.identity_type = 'PHONE'
        AND phone_identity.identity_value = input.phone
       WHERE input.identity_type = 'PHONE_JID' AND input.phone IS NOT NULL
       ON CONFLICT (session_id, evidence_source, source_observation_key) DO NOTHING`,
      [values[0], values[1], generation],
    );
  }

  private async inputIdentityIds(client: PoolClient, values: unknown[]): Promise<string[]> {
    const result = await client.query<{ id: string }>(
      `WITH input AS MATERIALIZED (SELECT * FROM ${evidenceInputRelation})
       SELECT DISTINCT identity.id
       FROM input JOIN observed_contact_identities identity
         ON identity.session_id = $1 AND identity.identity_type = input.identity_type
        AND identity.identity_value = input.identity_value`,
      values.slice(0, 2),
    );
    return result.rows.map(row => row.id);
  }
}
