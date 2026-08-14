import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { ContactMemberIdentityBackfillRepository } from '../../src/modules/contacts/contact-member-identity-backfill.repository';
import {
  INTEGRATION_GROUP_ID,
  INTEGRATION_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
  seedSendableGroup,
} from '../support/integration-database';

describe('member identity projection backfill', () => {
  let pool: Pool;
  let database: DatabaseService;
  let repository: ContactMemberIdentityBackfillRepository;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    repository = new ContactMemberIdentityBackfillRepository(database);
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await pool.query(
      `UPDATE contact_member_identity_backfill_state SET status = 'PENDING', rows_processed = 0,
         last_session_id = NULL, last_group_id = NULL, last_participant_id = NULL,
         attempt_count = 0, next_attempt_at = now(), lease_token = NULL, lease_expires_at = NULL,
         last_error_code = NULL, started_at = NULL, completed_at = NULL, updated_at = now()
       WHERE job_name = 'MEMBER_IDENTITY_V1'`,
    );
    await seedSendableGroup(pool);
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
    await pool.end();
  });

  it('backfills exact identity type without treating a LID user-part as a phone', async () => {
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, is_admin, is_super_admin)
       VALUES
         ($1, $2, 'opaque-lid@lid', 'opaque-lid', false, false),
         ($1, $2, '628111@c.us', '628111', false, false),
         ($1, $2, '628222:7@s.whatsapp.net', '628222', false, false),
         ($1, $2, 'newsletter@broadcast', 'newsletter', false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );

    const lease = await repository.claim();
    expect(lease).not.toBeNull();
    await expect(repository.processBatch(lease!, 2)).resolves.toMatchObject({
      updated: 2, completed: false, lostOwnership: false,
    });
    await expect(repository.processBatch(lease!, 2)).resolves.toMatchObject({
      updated: 2, completed: true, lostOwnership: false,
    });

    const members = await pool.query<{
      participant_id: string;
      identity_type: string;
      resolved_phone_number: string | null;
    }>(
      `SELECT participant_id, identity_type, resolved_phone_number FROM group_members
       WHERE session_id = $1 AND group_id = $2 ORDER BY participant_id`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(members.rows).toEqual([
      { participant_id: '628111@c.us', identity_type: 'PHONE_JID', resolved_phone_number: '628111' },
      {
        participant_id: '628222:7@s.whatsapp.net',
        identity_type: 'PHONE_JID',
        resolved_phone_number: '628222',
      },
      { participant_id: 'newsletter@broadcast', identity_type: 'OTHER_JID', resolved_phone_number: null },
      { participant_id: 'opaque-lid@lid', identity_type: 'LID', resolved_phone_number: null },
    ]);
    const state = await pool.query<{ status: string; rows_processed: string; lease_token: string | null }>(
      `SELECT status, rows_processed::text, lease_token
       FROM contact_member_identity_backfill_state WHERE job_name = 'MEMBER_IDENTITY_V1'`,
    );
    expect(state.rows[0]).toEqual({ status: 'COMPLETED', rows_processed: '4', lease_token: null });
    await expect(repository.claim()).resolves.toBeNull();
  });

  it('reopens completed work for a late null row and fences an expired owner', async () => {
    await pool.query(
      `UPDATE contact_member_identity_backfill_state SET status = 'COMPLETED', completed_at = now()
       WHERE job_name = 'MEMBER_IDENTITY_V1'`,
    );
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, is_admin, is_super_admin)
       VALUES ($1, $2, 'late@lid', 'late', false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    const staleLease = await repository.claim();
    expect(staleLease).not.toBeNull();
    await pool.query(
      `UPDATE contact_member_identity_backfill_state SET lease_expires_at = now() - interval '1 second'
       WHERE job_name = 'MEMBER_IDENTITY_V1'`,
    );
    const currentLease = await repository.claim();
    expect(currentLease).not.toBeNull();
    expect(currentLease).not.toBe(staleLease);
    await expect(repository.processBatch(staleLease!, 100)).resolves.toEqual({
      updated: 0, completed: false, lostOwnership: true,
    });
    await expect(repository.processBatch(currentLease!, 100)).resolves.toMatchObject({
      updated: 1, completed: true, lostOwnership: false,
    });
  });

  it('releases unfinished work without waiting for lease expiry', async () => {
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, is_admin, is_super_admin)
       VALUES
         ($1, $2, 'first@lid', 'first', false, false),
         ($1, $2, 'second@lid', 'second', false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    const firstLease = (await repository.claim())!;
    await expect(repository.processBatch(firstLease, 1)).resolves.toMatchObject({
      updated: 1, completed: false, lostOwnership: false,
    });
    await expect(repository.release(firstLease)).resolves.toBe(true);
    const secondLease = await repository.claim();
    expect(secondLease).not.toBeNull();
    expect(secondLease).not.toBe(firstLease);
    await expect(repository.processBatch(secondLease!, 10)).resolves.toMatchObject({
      updated: 1, completed: true, lostOwnership: false,
    });
  });
});
