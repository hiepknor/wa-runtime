import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { ContactEvidenceWriter } from '../../src/modules/contacts/contact-evidence.writer';
import { ContactRepository } from '../../src/modules/contacts/contact.repository';
import {
  DISALLOWED_SESSION_ID,
  INTEGRATION_GROUP_ID,
  INTEGRATION_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
  seedSendableGroup,
} from '../support/integration-database';

describe('contact evidence dual-write', () => {
  let pool: Pool;
  let database: DatabaseService;
  let repository: ContactRepository;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    repository = new ContactRepository(database, true, 30, new ContactEvidenceWriter(true));
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await seedSendableGroup(pool);
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
    await pool.end();
  });

  const participant = {
      id: '84970000000@c.us',
      number: '84970000000',
      name: 'Membership evidence',
      isAdmin: false,
      isSuperAdmin: false,
  };

  const projectGroupMember = async (): Promise<void> => {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      await repository.seedGroupMembers(
        client,
        INTEGRATION_SESSION_ID,
        INTEGRATION_GROUP_ID,
        [participant],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  const seedGroupMember = async (): Promise<void> => {
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, is_admin, is_super_admin)
       VALUES ($1, $2, $3, $4, false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, participant.id, participant.number],
    );
    await projectGroupMember();
  };

  it('records group and message evidence idempotently without changing the legacy projection', async () => {
    await seedGroupMember();
    await projectGroupMember();

    expect(await repository.observeMessageSender(
      INTEGRATION_SESSION_ID,
      '84970000000@c.us',
      'Message evidence',
      new Date('2026-08-14T04:00:00.000Z'),
      'message-evidence-1',
    )).toBe(true);
    expect(await repository.observeMessageSender(
      INTEGRATION_SESSION_ID,
      '84970000000@c.us',
      'Message evidence',
      new Date('2026-08-14T04:00:00.000Z'),
      'message-evidence-1',
    )).toBe(false);

    const identities = await pool.query<{ identity_type: string; count: string }>(
      `SELECT identity_type, count(*)::text AS count FROM observed_contact_identities
       WHERE session_id = $1 GROUP BY identity_type ORDER BY identity_type`,
      [INTEGRATION_SESSION_ID],
    );
    expect(identities.rows).toEqual([
      { identity_type: 'PHONE', count: '1' },
      { identity_type: 'PHONE_JID', count: '1' },
    ]);

    const observations = await pool.query<{
      observation_source: string;
      observation_scope: string;
      count: string;
    }>(
      `SELECT observation_source, observation_scope, count(*)::text AS count
       FROM contact_observations WHERE session_id = $1
       GROUP BY observation_source, observation_scope ORDER BY observation_source`,
      [INTEGRATION_SESSION_ID],
    );
    expect(observations.rows).toEqual([
      {
        observation_source: 'GROUP_PARTICIPANT_NAME',
        observation_scope: 'MEMBERSHIP',
        count: '1',
      },
      { observation_source: 'OPENWA_PUSH_NAME', observation_scope: 'IDENTITY', count: '1' },
    ]);

    const links = await pool.query<{ evidence_source: string; count: string }>(
      `SELECT evidence_source, count(*)::text AS count FROM contact_link_evidence
       WHERE session_id = $1 GROUP BY evidence_source`,
      [INTEGRATION_SESSION_ID],
    );
    expect(links.rows).toEqual([{ evidence_source: 'PHONE_JID_DERIVATION', count: '1' }]);

    const member = await pool.query<{ display_name: string; display_name_source: string }>(
      `SELECT display_name, display_name_source FROM group_members
       WHERE session_id = $1 AND group_id = $2`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(member.rows[0]).toEqual({
      display_name: 'Membership evidence',
      display_name_source: 'GROUP_PARTICIPANT_NAME',
    });
  });

  it('materializes snapshot evidence only in the publication transaction', async () => {
    const claim = await repository.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    await repository.ingestObservedPage(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
      [{
        id: '12345@lid',
        number: '84971111111',
        name: 'Snapshot contact evidence',
        pushName: 'Snapshot push evidence',
        isMyContact: true,
        isBlocked: false,
        profilePicUrl: null,
      }],
    );
    const beforePublication = await pool.query<{ identities: string; observations: string; links: string }>(
      `SELECT
         (SELECT count(*) FROM observed_contact_identities)::text AS identities,
         (SELECT count(*) FROM contact_observations)::text AS observations,
         (SELECT count(*) FROM contact_link_evidence)::text AS links`,
    );
    expect(beforePublication.rows[0]).toEqual({ identities: '0', observations: '0', links: '0' });

    await repository.reconcileObservedIdentities(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
    );
    await repository.completeObservedSnapshot(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
      1,
      86_400_000,
    );

    const published = await pool.query<{
      identities: string;
      observations: string;
      links: string;
      generation: string;
    }>(
      `SELECT
         (SELECT count(*) FROM observed_contact_identities WHERE session_id = $1)::text AS identities,
         (SELECT count(*) FROM contact_observations WHERE session_id = $1)::text AS observations,
         (SELECT count(*) FROM contact_link_evidence WHERE session_id = $1)::text AS links,
         (SELECT min(source_generation)::text FROM contact_observations WHERE session_id = $1) AS generation`,
      [INTEGRATION_SESSION_ID],
    );
    expect(published.rows[0]).toEqual({
      identities: '2',
      observations: '2',
      links: '1',
      generation: String(claim!.generation),
    });

    const failed = await repository.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    await repository.ingestObservedPage(
      INTEGRATION_SESSION_ID,
      failed!.generation,
      failed!.leaseToken,
      [{
        id: 'another@lid',
        number: '',
        name: 'Must not publish',
        pushName: null,
        isMyContact: false,
        isBlocked: false,
        profilePicUrl: null,
      }],
    );
    await repository.failObservedSnapshot(
      INTEGRATION_SESSION_ID,
      failed!.generation,
      failed!.leaseToken,
      'UPSTREAM_ERROR',
    );
    const afterFailure = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM contact_observations WHERE session_id = $1`,
      [INTEGRATION_SESSION_ID],
    );
    expect(afterFailure.rows[0]?.count).toBe('2');
  });

  it('does not write evidence when the rollout flag is disabled', async () => {
    const disabled = new ContactRepository(database, true, 30, new ContactEvidenceWriter(false));
    const claim = await disabled.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    await disabled.ingestObservedPage(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
      [{
        id: 'disabled@lid', number: '', name: 'Disabled', pushName: null,
        isMyContact: false, isBlocked: false, profilePicUrl: null,
      }],
    );
    await disabled.reconcileObservedIdentities(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
    );
    await disabled.completeObservedSnapshot(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
      1,
      86_400_000,
    );
    const evidence = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM observed_contact_identities`,
    );
    expect(evidence.rows[0]?.count).toBe('0');
  });

  it('enforces session ownership on every evidence reference', async () => {
    await pool.query(
      `INSERT INTO gateway_sessions
         (id, name, status, engine_loaded, gateway_created_at, gateway_updated_at)
       VALUES ($1, 'Second evidence session', 'ready', true, now(), now())`,
      [DISALLOWED_SESSION_ID],
    );
    const foreignIdentity = await pool.query<{ id: string }>(
      `INSERT INTO observed_contact_identities (session_id, identity_type, identity_value)
       VALUES ($1, 'LID', 'foreign@lid') RETURNING id`,
      [DISALLOWED_SESSION_ID],
    );

    await expect(pool.query(
      `INSERT INTO contact_observations
         (session_id, identity_id, observation_source, observation_scope,
          name_value, source_observed_at, source_observation_key)
       VALUES ($1, $2, 'OPENWA_PUSH_NAME', 'IDENTITY', 'Cross session', now(), 'cross-session')`,
      [INTEGRATION_SESSION_ID, foreignIdentity.rows[0]!.id],
    )).rejects.toMatchObject({ code: '23503' });
  });
});
