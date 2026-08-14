import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { ContactRepository } from '../../src/modules/contacts/contact.repository';
import {
  INTEGRATION_GROUP_ID,
  INTEGRATION_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
  seedSendableGroup,
} from '../support/integration-database';

const memberId = '84970000000@c.us';
const secondGroupId = '120363000000000001@g.us';

describe('contact name resolution', () => {
  let pool: Pool;
  let database: DatabaseService;
  let contacts: ContactRepository;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    contacts = new ContactRepository(database);
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await seedSendableGroup(pool);
    await pool.query(
      `INSERT INTO gateway_groups
         (session_id, id, name, is_admin, is_read_only, is_announce, details_synced_at,
          send_capability, send_capability_reason, capability_checked_at)
       VALUES ($1, $2, 'Second integration group', true, false, false, now(),
         'ALLOWED', 'SEND_ALLOWED', now())`,
      [INTEGRATION_SESSION_ID, secondGroupId],
    );
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
    await pool.end();
  });

  const projectMember = async (groupId: string, participantName: string | null): Promise<void> => {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      await contacts.seedGroupMembers(client, INTEGRATION_SESSION_ID, groupId, [{
        id: memberId,
        number: '84970000000',
        name: participantName,
        isAdmin: false,
        isSuperAdmin: false,
      }]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  const seedMember = async (groupId: string, participantName: string | null): Promise<void> => {
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, is_admin, is_super_admin)
       VALUES ($1, $2, $3, '84970000000', false, false)`,
      [INTEGRATION_SESSION_ID, groupId, memberId],
    );
    await projectMember(groupId, participantName);
  };

  it('keeps participant names membership-local and applies one deterministic precedence', async () => {
    expect(await contacts.observeMessageSender(
      INTEGRATION_SESSION_ID,
      memberId,
      'Initial push name',
      new Date('2026-08-14T01:00:00.000Z'),
      'push-before-groups',
    )).toBe(true);

    await seedMember(INTEGRATION_GROUP_ID, 'First group participant');
    await seedMember(secondGroupId, 'Second group participant');

    const participantNames = await pool.query<{
      group_id: string;
      display_name: string;
      display_name_source: string;
    }>(
      `SELECT group_id, display_name, display_name_source
       FROM group_members WHERE session_id = $1 AND participant_id = $2 ORDER BY group_id`,
      [INTEGRATION_SESSION_ID, memberId],
    );
    expect(participantNames.rows).toEqual([
      {
        group_id: INTEGRATION_GROUP_ID,
        display_name: 'First group participant',
        display_name_source: 'GROUP_PARTICIPANT_NAME',
      },
      {
        group_id: secondGroupId,
        display_name: 'Second group participant',
        display_name_source: 'GROUP_PARTICIPANT_NAME',
      },
    ]);

    expect(await contacts.observeMessageSender(
      INTEGRATION_SESSION_ID,
      memberId,
      'Later push name',
      new Date('2026-08-14T02:00:00.000Z'),
      'push-after-groups',
    )).toBe(true);
    const afterPush = await pool.query<{ display_name: string; display_name_source: string }>(
      `SELECT display_name, display_name_source FROM group_members
       WHERE session_id = $1 AND participant_id = $2 ORDER BY group_id`,
      [INTEGRATION_SESSION_ID, memberId],
    );
    expect(afterPush.rows).toEqual([
      { display_name: 'First group participant', display_name_source: 'GROUP_PARTICIPANT_NAME' },
      { display_name: 'Second group participant', display_name_source: 'GROUP_PARTICIPANT_NAME' },
    ]);

    const snapshot = await contacts.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    expect(snapshot).not.toBeNull();
    await contacts.ingestObservedPage(
      INTEGRATION_SESSION_ID,
      snapshot!.generation,
      snapshot!.leaseToken,
      [{
        id: memberId,
        number: '84970000000',
        name: 'Saved contact name',
        pushName: 'Snapshot push name',
        isMyContact: true,
        isBlocked: false,
        profilePicUrl: null,
      }],
    );
    const afterContact = await pool.query<{ display_name: string; display_name_source: string }>(
      `SELECT display_name, display_name_source FROM group_members
       WHERE session_id = $1 AND participant_id = $2 ORDER BY group_id`,
      [INTEGRATION_SESSION_ID, memberId],
    );
    expect(afterContact.rows).toEqual([
      { display_name: 'Saved contact name', display_name_source: 'OPENWA_CONTACT_NAME' },
      { display_name: 'Saved contact name', display_name_source: 'OPENWA_CONTACT_NAME' },
    ]);

    await projectMember(secondGroupId, 'Participant observed after contact');
    const afterLaterParticipant = await pool.query<{ display_name: string; display_name_source: string }>(
      `SELECT display_name, display_name_source FROM group_members
       WHERE session_id = $1 AND group_id = $2 AND participant_id = $3`,
      [INTEGRATION_SESSION_ID, secondGroupId, memberId],
    );
    expect(afterLaterParticipant.rows[0]).toEqual({
      display_name: 'Saved contact name',
      display_name_source: 'OPENWA_CONTACT_NAME',
    });

    const globalParticipantNames = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM contact_names
       WHERE session_id = $1 AND name_source = 'GROUP_PARTICIPANT_NAME'`,
      [INTEGRATION_SESSION_ID],
    );
    expect(globalParticipantNames.rows[0]?.count).toBe('0');
  });

  it('rejects an older or replayed push-name observation without rewriting the projection', async () => {
    await seedMember(INTEGRATION_GROUP_ID, null);
    const newerAt = new Date('2026-08-14T03:00:00.000Z');
    expect(await contacts.observeMessageSender(
      INTEGRATION_SESSION_ID,
      memberId,
      'Newer push name',
      newerAt,
      'push-newer',
    )).toBe(true);

    const beforeReplay = await pool.query<{
      name_value: string;
      source_observed_at: Date;
      source_observation_key: string;
      updated_at: Date;
    }>(
      `SELECT name_value, source_observed_at, source_observation_key, updated_at
       FROM contact_names
       WHERE session_id = $1 AND name_source = 'OPENWA_PUSH_NAME'`,
      [INTEGRATION_SESSION_ID],
    );

    expect(await contacts.observeMessageSender(
      INTEGRATION_SESSION_ID,
      memberId,
      'Older push name',
      new Date('2026-08-14T02:00:00.000Z'),
      'push-older',
    )).toBe(false);
    expect(await contacts.observeMessageSender(
      INTEGRATION_SESSION_ID,
      memberId,
      'Newer push name',
      newerAt,
      'push-newer',
    )).toBe(false);

    const afterReplay = await pool.query<{
      name_value: string;
      source_observed_at: Date;
      source_observation_key: string;
      updated_at: Date;
    }>(
      `SELECT name_value, source_observed_at, source_observation_key, updated_at
       FROM contact_names
       WHERE session_id = $1 AND name_source = 'OPENWA_PUSH_NAME'`,
      [INTEGRATION_SESSION_ID],
    );
    expect(afterReplay.rows).toEqual(beforeReplay.rows);

    const member = await pool.query<{ display_name: string; display_name_source: string }>(
      `SELECT display_name, display_name_source FROM group_members
       WHERE session_id = $1 AND group_id = $2 AND participant_id = $3`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, memberId],
    );
    expect(member.rows[0]).toEqual({
      display_name: 'Newer push name',
      display_name_source: 'OPENWA_PUSH_NAME',
    });
  });
});
