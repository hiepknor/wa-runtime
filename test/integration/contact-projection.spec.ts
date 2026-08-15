import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { ContactEvidenceWriter } from '../../src/modules/contacts/contact-evidence.writer';
import { ContactProjectionRepository } from '../../src/modules/contacts/contact-projection.repository';
import { ContactResolutionRepository } from '../../src/modules/contacts/contact-resolution.repository';
import { ContactRepository } from '../../src/modules/contacts/contact.repository';
import { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import {
  INTEGRATION_GROUP_ID,
  INTEGRATION_SESSION_ID,
  DISALLOWED_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
  seedSendableGroup,
} from '../support/integration-database';

describe('durable contact projection', () => {
  let pool: Pool;
  let database: DatabaseService;
  let evidence: ContactEvidenceWriter;
  let contacts: ContactRepository;
  let resolutions: ContactResolutionRepository;
  let projections: ContactProjectionRepository;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    evidence = new ContactEvidenceWriter(true, true);
    contacts = new ContactRepository(database, true, 30, evidence);
    resolutions = new ContactResolutionRepository(database, true);
    projections = new ContactProjectionRepository(database);
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await pool.query(
      `UPDATE contact_projection_bootstrap_state SET status = 'PENDING',
         last_session_id = NULL, last_identity_id = NULL, rows_enqueued = 0,
         completed_at = NULL, updated_at = now()
       WHERE job_name = 'MEMBER_PROJECTION_V2'`,
    );
    await pool.query(
      `UPDATE contact_evidence_backfill_state SET status = 'PENDING',
         last_session_id = NULL, last_group_id = NULL, last_participant_id = NULL,
         rows_processed = 0, completed_at = NULL, updated_at = now()
       WHERE job_name = 'MEMBER_EVIDENCE_V2'`,
    );
    await seedSendableGroup(pool);
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
    await pool.end();
  });

  const publishAndResolve = async (name: string | null = 'Saved contact') => {
    const claim = await contacts.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    await contacts.ingestObservedPage(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
      [{
        id: 'lid-a@lid',
        number: '84970000000',
        name,
        pushName: null,
        isMyContact: name !== null,
        isBlocked: false,
        profilePicUrl: null,
      }],
    );
    await contacts.completeObservedSnapshot(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
      1,
      86_400_000,
    );
    await resolutions.enqueuePublished(10);
    const resolution = await resolutions.claim();
    await resolutions.resolve(resolution!);
    return resolution!;
  };

  const drain = async (batchSize = 2) => {
    let updated = 0;
    for (let index = 0; index < 50; index += 1) {
      const claim = await projections.claim();
      if (!claim) return updated;
      for (;;) {
        const result = await projections.projectBatch(claim, batchSize);
        updated += result.updated;
        if (result.completed) break;
      }
    }
    throw new Error('projection queue did not drain');
  };

  it('projects one resolved identity across bounded membership batches', async () => {
    await pool.query(
      `INSERT INTO gateway_groups
         (session_id, id, name, is_active, synced_at)
       SELECT $1, 'projection-group-' || value, 'Projection group', true, now()
       FROM generate_series(1, 4) value`,
      [INTEGRATION_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number,
          participant_display_name, is_admin, is_super_admin)
       SELECT $1, group_id, 'lid-a@lid', 'lid-a', 'Membership name', false, false
       FROM (
         SELECT $2::text AS group_id
         UNION ALL SELECT 'projection-group-' || value FROM generate_series(1, 4) value
       ) groups`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    await database.transaction(async client => {
      await contacts.seedGroupMembers(client, INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, [{
        id: 'lid-a@lid', number: 'lid-a', name: 'Membership name', isAdmin: false, isSuperAdmin: false,
      }]);
      for (let value = 1; value <= 4; value += 1) {
        await contacts.seedGroupMembers(client, INTEGRATION_SESSION_ID, `projection-group-${value}`, [{
          id: 'lid-a@lid', number: 'lid-a', name: 'Membership name', isAdmin: false, isSuperAdmin: false,
        }]);
      }
    });
    const resolution = await publishAndResolve();

    expect(await drain(2)).toBeGreaterThanOrEqual(5);
    const members = await pool.query<{
      evidence_identity_id: string | null;
      shadow_resolved_phone_number: string | null;
      shadow_display_name: string | null;
      shadow_display_name_source: string | null;
      shadow_projection_revision: string;
      shadow_resolution_run_id: string | null;
    }>(
      `SELECT evidence_identity_id, shadow_resolved_phone_number, shadow_display_name,
         shadow_display_name_source, shadow_projection_revision::text, shadow_resolution_run_id
       FROM group_members WHERE session_id = $1 AND participant_id = 'lid-a@lid'
       ORDER BY group_id`,
      [INTEGRATION_SESSION_ID],
    );
    expect(members.rows).toHaveLength(5);
    expect(members.rows.every(row => row.evidence_identity_id !== null)).toBe(true);
    expect(members.rows.every(row => row.shadow_resolved_phone_number === '84970000000')).toBe(true);
    expect(members.rows.every(row => row.shadow_display_name === 'Saved contact')).toBe(true);
    expect(members.rows.every(row => row.shadow_display_name_source === 'OPENWA_CONTACT_NAME')).toBe(true);
    expect(members.rows.every(row => row.shadow_resolution_run_id === resolution.runId)).toBe(true);
    expect(members.rows.every(row => Number(row.shadow_projection_revision) > 0)).toBe(true);

    await pool.query(
      `UPDATE group_members SET display_name = 'Stale legacy', display_name_source = 'OPENWA_PUSH_NAME'
       WHERE session_id = $1 AND participant_id = 'lid-a@lid'`,
      [INTEGRATION_SESSION_ID],
    );
    await database.transaction(client => evidence.observeMessageSender(
      client,
      INTEGRATION_SESSION_ID,
      { identity_type: 'LID', identity_value: 'lid-a@lid', phone: null },
      'Ignored lower-precedence push',
      new Date('2026-08-14T06:02:00.000Z'),
      'message:mirror-legacy',
    ));
    const mirror = new ContactProjectionRepository(database, true);
    for (;;) {
      const claim = await mirror.claim();
      if (!claim) break;
      for (;;) {
        const result = await mirror.projectBatch(claim, 10);
        if (result.completed) break;
      }
    }
    const mirrored = await pool.query<{
      display_name: string;
      resolved_phone_number: string;
    }>(
      `SELECT display_name, resolved_phone_number FROM group_members
       WHERE session_id = $1 AND participant_id = 'lid-a@lid'`,
      [INTEGRATION_SESSION_ID],
    );
    expect(mirrored.rows.every(row => row.display_name === 'Saved contact')).toBe(true);
    expect(mirrored.rows.every(row => row.resolved_phone_number === '84970000000')).toBe(true);
  });

  it('enqueues only material changes after the first resolution generation', async () => {
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, is_admin, is_super_admin)
       VALUES ($1, $2, 'lid-a@lid', 'lid-a', false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    await database.transaction(client => contacts.seedGroupMembers(
      client,
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      [{ id: 'lid-a@lid', number: 'lid-a', name: null, isAdmin: false, isSuperAdmin: false }],
    ));
    await publishAndResolve();
    await drain();
    const initial = await pool.query<{ requested_revision: string }>(
      `SELECT requested_revision::text FROM contact_projection_work
       WHERE session_id = $1`,
      [INTEGRATION_SESSION_ID],
    );

    await publishAndResolve();
    expect(await projections.claim()).toBeNull();
    const unchanged = await pool.query<{ requested_revision: string }>(
      `SELECT requested_revision::text FROM contact_projection_work
       WHERE session_id = $1`,
      [INTEGRATION_SESSION_ID],
    );
    expect(unchanged.rows).toEqual(initial.rows);

    await publishAndResolve('Renamed saved contact');
    const changed = await projections.claim();
    expect(changed).not.toBeNull();
    expect(await projections.projectBatch(changed!, 10)).toMatchObject({
      updated: 1,
      completed: true,
    });
    expect(await projections.claim()).toBeNull();
    const member = await pool.query<{ shadow_display_name: string }>(
      `SELECT shadow_display_name FROM group_members
       WHERE session_id = $1 AND group_id = $2 AND participant_id = 'lid-a@lid'`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(member.rows[0]?.shadow_display_name).toBe('Renamed saved contact');
  });

  it('coalesces replayed observations and schedules a newer revision during an active claim', async () => {
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, is_admin, is_super_admin)
       VALUES ($1, $2, 'lid-a@lid', 'lid-a', false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    await database.transaction(client => contacts.seedGroupMembers(
      client,
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      [{ id: 'lid-a@lid', number: 'lid-a', name: null, isAdmin: false, isSuperAdmin: false }],
    ));
    await publishAndResolve(null);
    await drain();

    const observe = () => database.transaction(client => evidence.observeMessageSender(
      client,
      INTEGRATION_SESSION_ID,
      { identity_type: 'LID', identity_value: 'lid-a@lid', phone: null },
      'Push name',
      new Date('2026-08-14T06:00:00.000Z'),
      'message:stable',
    ));
    await observe();
    const beforeReplay = await pool.query<{ requested_revision: string }>(
      `SELECT requested_revision::text FROM contact_projection_work
       WHERE session_id = $1 AND status = 'PENDING'`,
      [INTEGRATION_SESSION_ID],
    );
    await observe();
    const afterReplay = await pool.query<{ requested_revision: string }>(
      `SELECT requested_revision::text FROM contact_projection_work
       WHERE session_id = $1 AND status = 'PENDING'`,
      [INTEGRATION_SESSION_ID],
    );
    expect(afterReplay.rows[0]?.requested_revision).toBe(beforeReplay.rows[0]?.requested_revision);

    await database.transaction(client => evidence.observeMessageSender(
      client,
      INTEGRATION_SESSION_ID,
      { identity_type: 'LID', identity_value: 'lid-a@lid', phone: null },
      'Push name',
      new Date('2026-08-14T06:00:30.000Z'),
      'message:same-name-newer',
    ));
    await database.transaction(client => evidence.observeMessageSender(
      client,
      INTEGRATION_SESSION_ID,
      { identity_type: 'LID', identity_value: 'lid-a@lid', phone: null },
      'Out-of-order name',
      new Date('2026-08-14T05:59:00.000Z'),
      'message:older-different-name',
    ));
    const afterNoOpObservations = await pool.query<{ requested_revision: string }>(
      `SELECT requested_revision::text FROM contact_projection_work
       WHERE session_id = $1 AND status = 'PENDING'`,
      [INTEGRATION_SESSION_ID],
    );
    expect(afterNoOpObservations.rows[0]?.requested_revision).toBe(
      beforeReplay.rows[0]?.requested_revision,
    );
    const retainedObservations = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM contact_observations
       WHERE session_id = $1 AND observation_source = 'OPENWA_PUSH_NAME'
         AND source_observation_key IN ('message:same-name-newer', 'message:older-different-name')`,
      [INTEGRATION_SESSION_ID],
    );
    expect(retainedObservations.rows[0]?.count).toBe('2');

    const active = await projections.claim();
    expect(active).not.toBeNull();
    await database.transaction(client => evidence.observeMessageSender(
      client,
      INTEGRATION_SESSION_ID,
      { identity_type: 'LID', identity_value: 'lid-a@lid', phone: null },
      'Newer push name',
      new Date('2026-08-14T06:01:00.000Z'),
      'message:newer',
    ));
    const revisions = await pool.query<{ requested_revision: string; active_revision: string }>(
      `SELECT requested_revision::text, active_revision::text FROM contact_projection_work
       WHERE session_id = $1 AND identity_id = $2`,
      [INTEGRATION_SESSION_ID, active!.identityId],
    );
    expect(Number(revisions.rows[0]?.requested_revision)).toBeGreaterThan(
      Number(revisions.rows[0]?.active_revision),
    );
    const cutoffCoversObservation = await pool.query<{ covered: boolean }>(
      `SELECT work.requested_cutoff_at >= max(observation.created_at) AS covered
       FROM contact_projection_work work
       JOIN contact_observations observation ON observation.session_id = work.session_id
       WHERE work.session_id = $1 AND work.identity_id = $2
         AND observation.observation_source = 'OPENWA_PUSH_NAME'
       GROUP BY work.requested_cutoff_at`,
      [INTEGRATION_SESSION_ID, active!.identityId],
    );
    expect(cutoffCoversObservation.rows[0]?.covered).toBe(true);
    await projections.projectBatch(active!, 10);
    const queuedAgain = await pool.query<{ status: string }>(
      `SELECT status FROM contact_projection_work WHERE session_id = $1 AND identity_id = $2`,
      [INTEGRATION_SESSION_ID, active!.identityId],
    );
    expect(queuedAgain.rows[0]?.status).toBe('PENDING');
    const secondClaim = await projections.claim();
    expect(secondClaim).toMatchObject({ identityId: active!.identityId });
    const activeCutoff = await pool.query<{ covered: boolean }>(
      `SELECT work.active_cutoff_at >= max(observation.created_at) AS covered
       FROM contact_projection_work work
       JOIN contact_observations observation ON observation.session_id = work.session_id
       WHERE work.session_id = $1 AND work.identity_id = $2
         AND observation.observation_source = 'OPENWA_PUSH_NAME'
       GROUP BY work.active_cutoff_at`,
      [INTEGRATION_SESSION_ID, active!.identityId],
    );
    expect(activeCutoff.rows[0]?.covered).toBe(true);
    const projectionInputs = await pool.query<{
      contact_name: string | null;
      participant_name: string | null;
      exact_push_name: string | null;
    }>(
      `SELECT cluster.contact_display_name AS contact_name,
         member.participant_display_name AS participant_name,
         exact_push.name_value AS exact_push_name
       FROM group_members member
       JOIN contact_projection_work work
         ON work.session_id = member.session_id AND work.identity_id = $3
       LEFT JOIN resolved_identity_assignments assignment
         ON assignment.session_id = member.session_id
        AND assignment.run_id = work.active_resolution_run_id
        AND assignment.identity_id = member.evidence_identity_id
       LEFT JOIN resolved_contact_clusters cluster
         ON cluster.session_id = assignment.session_id AND cluster.run_id = assignment.run_id
        AND cluster.cluster_id = assignment.cluster_id
       LEFT JOIN LATERAL (
         SELECT observation.name_value FROM contact_observations observation
         WHERE observation.session_id = member.session_id
           AND observation.identity_id = member.evidence_identity_id
           AND observation.observation_source = 'OPENWA_PUSH_NAME'
           AND observation.created_at <= work.active_cutoff_at
         ORDER BY observation.source_observed_at DESC,
           observation.source_observation_key DESC, observation.id DESC LIMIT 1
       ) exact_push ON true
       WHERE member.session_id = $1 AND member.group_id = $2
         AND member.participant_id = 'lid-a@lid'`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, active!.identityId],
    );
    expect(projectionInputs.rows[0]).toEqual({
      contact_name: null,
      participant_name: null,
      exact_push_name: 'Newer push name',
    });
    expect((await projections.projectBatch(secondClaim!, 10)).completed).toBe(true);
    await drain();
    const completedWork = await pool.query<{
      requested_revision: string;
      completed_revision: string;
      status: string;
    }>(
      `SELECT requested_revision::text, completed_revision::text, status
       FROM contact_projection_work WHERE session_id = $1 AND identity_id = $2`,
      [INTEGRATION_SESSION_ID, active!.identityId],
    );
    expect(completedWork.rows[0]).toMatchObject({
      requested_revision: revisions.rows[0]!.requested_revision,
      completed_revision: revisions.rows[0]!.requested_revision,
      status: 'IDLE',
    });
    const pushNames = await pool.query<{ name_value: string }>(
      `SELECT name_value FROM contact_observations
       WHERE session_id = $1 AND observation_source = 'OPENWA_PUSH_NAME'
       ORDER BY source_observed_at`,
      [INTEGRATION_SESSION_ID],
    );
    expect(pushNames.rows.map(row => row.name_value)).toEqual([
      'Out-of-order name',
      'Push name',
      'Push name',
      'Newer push name',
    ]);
    const latestExactPush = await pool.query<{ name_value: string }>(
      `SELECT observation.name_value FROM group_members member
       JOIN contact_observations observation
         ON observation.session_id = member.session_id
        AND observation.identity_id = member.evidence_identity_id
       WHERE member.session_id = $1 AND member.group_id = $2
         AND member.participant_id = 'lid-a@lid'
         AND observation.observation_source = 'OPENWA_PUSH_NAME'
       ORDER BY observation.source_observed_at DESC,
         observation.source_observation_key DESC, observation.id DESC LIMIT 1`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(latestExactPush.rows[0]?.name_value).toBe('Newer push name');
    const member = await pool.query<{
      shadow_display_name: string;
      shadow_display_name_source: string;
      shadow_projection_revision: string;
    }>(
      `SELECT shadow_display_name, shadow_display_name_source, shadow_projection_revision::text
       FROM group_members
       WHERE session_id = $1 AND group_id = $2 AND participant_id = 'lid-a@lid'`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(member.rows[0]).toEqual({
      shadow_display_name: 'Newer push name',
      shadow_display_name_source: 'OPENWA_PUSH_NAME',
      shadow_projection_revision: revisions.rows[0]!.requested_revision,
    });
  });

  it('fences an expired worker and resumes its cursor with a new lease', async () => {
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, is_admin, is_super_admin)
       VALUES ($1, $2, 'lid-a@lid', 'lid-a', false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    await database.transaction(client => contacts.seedGroupMembers(
      client,
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      [{ id: 'lid-a@lid', number: 'lid-a', name: null, isAdmin: false, isSuperAdmin: false }],
    ));
    await publishAndResolve(null);
    const stale = await projections.claim();
    expect(stale).not.toBeNull();
    await pool.query(
      `UPDATE contact_projection_work SET lease_expires_at = now() - interval '1 second'
       WHERE session_id = $1 AND identity_id = $2`,
      [stale!.sessionId, stale!.identityId],
    );
    await expect(projections.projectBatch(stale!, 1)).rejects.toThrow('lost ownership');
    const resumed = await projections.claim();
    expect(resumed).toMatchObject({ sessionId: stale!.sessionId, identityId: stale!.identityId });
    expect(resumed?.leaseToken).not.toBe(stale!.leaseToken);
    expect((await projections.projectBatch(resumed!, 10)).completed).toBe(true);
  });

  it('rejects projection identities and resolution runs from another session', async () => {
    const run = await publishAndResolve(null);
    const identity = await pool.query<{ id: string }>(
      `SELECT id FROM observed_contact_identities
       WHERE session_id = $1 AND identity_type = 'LID' AND identity_value = 'lid-a@lid'`,
      [INTEGRATION_SESSION_ID],
    );
    await seedSendableGroup(pool, DISALLOWED_SESSION_ID);
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, is_admin, is_super_admin)
       VALUES ($1, $2, 'other@lid', 'other', false, false)`,
      [DISALLOWED_SESSION_ID, INTEGRATION_GROUP_ID],
    );

    await expect(pool.query(
      `INSERT INTO contact_projection_work (session_id, identity_id)
       VALUES ($1, $2)`,
      [DISALLOWED_SESSION_ID, identity.rows[0]!.id],
    )).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query(
      `UPDATE group_members SET shadow_resolution_run_id = $3
       WHERE session_id = $1 AND group_id = $2`,
      [DISALLOWED_SESSION_ID, INTEGRATION_GROUP_ID, run.runId],
    )).rejects.toMatchObject({ code: '23503' });
  });

  it('bootstraps pre-existing identities once with a durable keyset cursor', async () => {
    const identity = await pool.query<{ id: string }>(
      `INSERT INTO observed_contact_identities (session_id, identity_type, identity_value)
       VALUES ($1, 'LID', 'bootstrap@lid') RETURNING id`,
      [INTEGRATION_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number,
          evidence_identity_id, is_admin, is_super_admin)
       VALUES ($1, $2, 'bootstrap@lid', 'bootstrap', $3, false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, identity.rows[0]!.id],
    );

    expect(await projections.enqueueBootstrap(1)).toBe(1);
    expect(await projections.getQueueMetrics()).toMatchObject({ pending: 1, failed: 0 });
    expect(await projections.enqueueBootstrap(1)).toBe(0);
    const state = await pool.query<{ status: string; rows_enqueued: string }>(
      `SELECT status, rows_enqueued::text FROM contact_projection_bootstrap_state
       WHERE job_name = 'MEMBER_PROJECTION_V2'`,
    );
    expect(state.rows[0]).toEqual({ status: 'COMPLETED', rows_enqueued: '1' });
    expect(await projections.enqueueBootstrap(1)).toBe(0);
  });

  it('claims only allowlisted work and reports inactive backlog separately', async () => {
    await seedSendableGroup(pool, DISALLOWED_SESSION_ID);
    const identities = await pool.query<{ session_id: string; id: string }>(
      `INSERT INTO observed_contact_identities (session_id, identity_type, identity_value)
       VALUES ($1, 'LID', 'allowed-queue@lid'), ($2, 'LID', 'inactive-queue@lid')
       RETURNING session_id, id`,
      [INTEGRATION_SESSION_ID, DISALLOWED_SESSION_ID],
    );
    for (const identity of identities.rows) {
      await pool.query(
        `INSERT INTO contact_projection_work (session_id, identity_id)
         VALUES ($1, $2)`,
        [identity.session_id, identity.id],
      );
    }
    await pool.query(
      `UPDATE contact_projection_work SET status = 'RUNNING',
         active_revision = requested_revision, active_cutoff_at = requested_cutoff_at,
         lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 second'
       WHERE session_id = $1`,
      [DISALLOWED_SESSION_ID],
    );
    const scoped = new ContactProjectionRepository(
      database, false, [INTEGRATION_SESSION_ID],
    );

    expect(await scoped.getQueueMetrics()).toMatchObject({
      pending: 1,
      inactivePending: 1,
      failed: 0,
    });
    const claim = await scoped.claim();
    expect(claim?.sessionId).toBe(INTEGRATION_SESSION_ID);
  });

  it('catches up members observed while projection was disabled', async () => {
    const identity = await pool.query<{ id: string }>(
      `INSERT INTO observed_contact_identities (session_id, identity_type, identity_value)
       VALUES ($1, 'LID', 'late-projection@lid') RETURNING id`,
      [INTEGRATION_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number,
          evidence_identity_id, is_admin, is_super_admin)
       VALUES ($1, $2, 'late-projection@lid', 'late-projection', $3, false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, identity.rows[0]!.id],
    );
    const scoped = new ContactProjectionRepository(
      database, false, [INTEGRATION_SESSION_ID],
    );

    expect(await scoped.catchUpUnprojected(10)).toBe(1);
    expect(await scoped.catchUpUnprojected(10)).toBe(0);
    const claim = await scoped.claim();
    expect(claim).not.toBeNull();
    expect(await scoped.projectBatch(claim!, 10)).toMatchObject({
      updated: 1,
      completed: true,
    });
    expect(await scoped.catchUpUnprojected(10)).toBe(0);
  });

  it('skips concurrent catch-up work while another scheduler owns the advisory lock', async () => {
    const owner = await pool.connect();
    try {
      await owner.query('BEGIN');
      await owner.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('contacts:projection:catch-up', 0)
         )`,
      );

      expect(await projections.catchUpUnprojected(10)).toBe(0);
    } finally {
      await owner.query('ROLLBACK');
      owner.release();
    }
  });

  it('serializes projection writes behind the session member-write lock', async () => {
    const identity = await pool.query<{ id: string }>(
      `INSERT INTO observed_contact_identities (session_id, identity_type, identity_value)
       VALUES ($1, 'LID', 'serialized-projection@lid') RETURNING id`,
      [INTEGRATION_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number,
          evidence_identity_id, is_admin, is_super_admin)
       VALUES ($1, $2, 'serialized-projection@lid', 'serialized-projection', $3, false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, identity.rows[0]!.id],
    );
    await database.transaction(client => evidence.observeMessageSender(
      client,
      INTEGRATION_SESSION_ID,
      { identity_type: 'LID', identity_value: 'serialized-projection@lid', phone: null },
      'Serialized projection',
      new Date('2026-08-14T06:04:00.000Z'),
      'message:serialized-projection',
    ));
    const claim = await projections.claim();
    expect(claim).not.toBeNull();

    const owner = await pool.connect();
    await owner.query('BEGIN');
    await owner.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('contact-member-projection' || ':' || $1, 0)
       )`,
      [INTEGRATION_SESSION_ID],
    );
    const projection = projections.projectBatch(claim!, 10);
    try {
      const outcome = await Promise.race([
        projection.then(() => 'completed'),
        new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 50)),
      ]);
      expect(outcome).toBe('blocked');
    } finally {
      await owner.query('ROLLBACK');
      owner.release();
    }
    expect(await projection).toMatchObject({ updated: 1, completed: true });
  });

  it('acquires the session member-write lock before replacing group members', async () => {
    const owner = await pool.connect();
    await owner.query('BEGIN');
    await owner.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('contact-member-projection' || ':' || $1, 0)
       )`,
      [INTEGRATION_SESSION_ID],
    );
    const write = new GatewayRepository(database, contacts).upsertGroupDetails(
      INTEGRATION_SESSION_ID,
      {
        id: INTEGRATION_GROUP_ID,
        name: 'Serialized group write',
        isAdmin: true,
        participants: [{
          id: 'serialized-member@lid',
          number: 'serialized-member',
          name: 'Serialized member',
          isAdmin: false,
          isSuperAdmin: false,
        }],
      },
    );
    try {
      const outcome = await Promise.race([
        write.then(() => 'completed'),
        new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 50)),
      ]);
      expect(outcome).toBe('blocked');
    } finally {
      await owner.query('ROLLBACK');
      owner.release();
    }
    expect(await write).toEqual({ members: 1, applied: true });
  });

  it('requeues the effective resolved cluster for a late membership', async () => {
    // Keep the LID identity deterministically outside the canonical minimum-UUID
    // position so this test always exercises alias-to-cluster requeueing.
    await pool.query(
      `INSERT INTO observed_contact_identities
         (id, session_id, identity_type, identity_value)
       VALUES ('ffffffff-ffff-4fff-bfff-ffffffffffff', $1, 'LID', 'lid-a@lid')`,
      [INTEGRATION_SESSION_ID],
    );
    await publishAndResolve();
    await drain();
    const identity = await pool.query<{ id: string; cluster_id: string }>(
      `SELECT assignment.identity_id AS id, assignment.cluster_id
       FROM contact_resolution_runs run
       JOIN resolved_identity_assignments assignment
         ON assignment.session_id = run.session_id AND assignment.run_id = run.id
       JOIN observed_contact_identities observed
         ON observed.session_id = assignment.session_id AND observed.id = assignment.identity_id
       WHERE run.session_id = $1 AND run.status = 'COMPLETED'
         AND assignment.resolution_status = 'RESOLVED'
         AND assignment.identity_id <> assignment.cluster_id
         AND observed.identity_type = 'LID'
       ORDER BY run.completed_at DESC, assignment.identity_id LIMIT 1`,
      [INTEGRATION_SESSION_ID],
    );
    expect(identity.rows[0]).toBeDefined();
    await pool.query(
      `INSERT INTO gateway_groups (session_id, id, name, is_active, synced_at)
       VALUES ($1, 'late-cluster-group', 'Late cluster group', true, now())`,
      [INTEGRATION_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number,
          evidence_identity_id, is_admin, is_super_admin)
       VALUES ($1, 'late-cluster-group', 'lid-a@lid', 'lid-a', $2, false, false)`,
      [INTEGRATION_SESSION_ID, identity.rows[0]!.id],
    );

    expect(await projections.catchUpUnprojected(10)).toBe(1);
    expect(await projections.catchUpUnprojected(10)).toBe(0);
    const claim = await projections.claim();
    expect(claim?.identityId).toBe(identity.rows[0]!.cluster_id);
    expect(await projections.projectBatch(claim!, 10)).toMatchObject({
      updated: 1,
      completed: true,
    });
    expect(await projections.catchUpUnprojected(10)).toBe(0);
  });

  it('repairs a projected membership whose materialized identity type is missing', async () => {
    const identity = await pool.query<{ id: string }>(
      `INSERT INTO observed_contact_identities
         (session_id, identity_type, identity_value)
       VALUES ($1, 'LID', 'missing-type@lid') RETURNING id`,
      [INTEGRATION_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, evidence_identity_id,
          identity_type, shadow_projection_revision, is_admin, is_super_admin)
       VALUES ($1, $2, 'missing-type@lid', 'missing-type', $3, NULL, 1, false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, identity.rows[0]!.id],
    );

    expect(await projections.catchUpUnprojected(10)).toBe(1);
    const claim = await projections.claim();
    expect(claim?.identityId).toBe(identity.rows[0]!.id);
    expect(await projections.projectBatch(claim!, 10)).toMatchObject({
      updated: 1,
      completed: true,
    });
    const member = await pool.query<{ identity_type: string | null }>(
      `SELECT identity_type FROM group_members
       WHERE session_id = $1 AND group_id = $2 AND participant_id = 'missing-type@lid'`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(member.rows[0]?.identity_type).toBe('LID');
    expect(await projections.catchUpUnprojected(10)).toBe(0);
  });

  it('coalesces pending alias work into its resolved cluster', async () => {
    await publishAndResolve();
    await drain();
    const assignment = await pool.query<{ identity_id: string; cluster_id: string }>(
      `SELECT assignment.identity_id, assignment.cluster_id
       FROM contact_resolution_runs run
       JOIN resolved_identity_assignments assignment
         ON assignment.session_id = run.session_id AND assignment.run_id = run.id
       WHERE run.session_id = $1 AND run.status = 'COMPLETED'
         AND assignment.resolution_status = 'RESOLVED'
         AND assignment.identity_id <> assignment.cluster_id
       ORDER BY run.completed_at DESC, assignment.identity_id LIMIT 1`,
      [INTEGRATION_SESSION_ID],
    );
    const alias = assignment.rows[0]!;
    await pool.query(
      `INSERT INTO contact_projection_work (session_id, identity_id)
       VALUES ($1, $2)
       ON CONFLICT (session_id, identity_id) DO UPDATE SET status = 'PENDING'`,
      [INTEGRATION_SESSION_ID, alias.identity_id],
    );

    expect(await projections.coalesceResolvedAliases(1)).toBe(1);
    const work = await pool.query<{ identity_id: string; status: string }>(
      `SELECT identity_id, status FROM contact_projection_work
       WHERE session_id = $1 AND identity_id = ANY($2::uuid[])
       ORDER BY identity_id`,
      [INTEGRATION_SESSION_ID, [alias.identity_id, alias.cluster_id]],
    );
    expect(new Map(work.rows.map(row => [row.identity_id, row.status]))).toEqual(new Map([
      [alias.identity_id, 'IDLE'],
      [alias.cluster_id, 'PENDING'],
    ]));
  });

  it('backfills exact member evidence in bounded durable pages without treating a LID as a phone', async () => {
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, participant_display_name,
          resolved_phone_number, is_admin, is_super_admin)
       VALUES
         ($1, $2, 'backfill@lid', 'backfill', 'LID member', NULL, false, false),
         ($1, $2, '84970000000@c.us', '84970000000', 'Phone member',
           '84970000000', false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );

    expect(await projections.backfillEvidence(1)).toBe(1);
    expect(await projections.backfillEvidence(1)).toBe(1);
    expect(await projections.backfillEvidence(1)).toBe(0);
    expect(await projections.backfillEvidence(1)).toBe(0);

    const members = await pool.query<{
      participant_id: string;
      evidence_identity_id: string | null;
    }>(
      `SELECT participant_id, evidence_identity_id FROM group_members
       WHERE session_id = $1 ORDER BY participant_id`,
      [INTEGRATION_SESSION_ID],
    );
    expect(members.rows.every(member => member.evidence_identity_id !== null)).toBe(true);
    const phones = await pool.query<{ identity_value: string }>(
      `SELECT identity_value FROM observed_contact_identities
       WHERE session_id = $1 AND identity_type = 'PHONE' ORDER BY identity_value`,
      [INTEGRATION_SESSION_ID],
    );
    expect(phones.rows).toEqual([{ identity_value: '84970000000' }]);
    const observations = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM contact_observations
       WHERE session_id = $1 AND observation_source = 'GROUP_PARTICIPANT_NAME'`,
      [INTEGRATION_SESSION_ID],
    );
    expect(observations.rows[0]?.count).toBe('2');
    const state = await pool.query<{ status: string; rows_processed: string }>(
      `SELECT status, rows_processed::text FROM contact_evidence_backfill_state
       WHERE job_name = 'MEMBER_EVIDENCE_V2'`,
    );
    expect(state.rows[0]).toEqual({ status: 'COMPLETED', rows_processed: '2' });
  });

  it('catches up late membership evidence after the one-shot backfill has completed', async () => {
    await pool.query(
      `UPDATE contact_evidence_backfill_state SET status = 'COMPLETED', completed_at = now()
       WHERE job_name = 'MEMBER_EVIDENCE_V2'`,
    );
    await seedSendableGroup(pool, DISALLOWED_SESSION_ID);
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, participant_display_name,
          is_admin, is_super_admin)
       VALUES
         ($1, $2, 'late-evidence@lid', 'late-evidence', 'Late LID', false, false),
         ($1, $2, '84970000001@c.us', '84970000001', 'Late phone', false, false),
         ($3, $2, '84970000002@c.us', '84970000002', 'Outside allowlist', false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, DISALLOWED_SESSION_ID],
    );
    const scoped = new ContactProjectionRepository(database, false, [INTEGRATION_SESSION_ID]);

    expect(await scoped.catchUpMissingEvidence(1)).toBe(1);
    expect(await scoped.catchUpMissingEvidence(1)).toBe(1);
    expect(await scoped.catchUpMissingEvidence(1)).toBe(0);

    const members = await pool.query<{
      session_id: string;
      participant_id: string;
      evidence_identity_id: string | null;
      identity_type: string | null;
    }>(
      `SELECT session_id, participant_id, evidence_identity_id, identity_type
       FROM group_members WHERE participant_id LIKE 'late-evidence%'
          OR participant_id LIKE '8497000000%@c.us'
       ORDER BY session_id, participant_id`,
    );
    const allowed = members.rows.filter(member => member.session_id === INTEGRATION_SESSION_ID);
    const outside = members.rows.find(member => member.session_id === DISALLOWED_SESSION_ID);
    expect(allowed).toHaveLength(2);
    expect(allowed.every(member => member.evidence_identity_id !== null)).toBe(true);
    expect(allowed.map(member => member.identity_type).sort()).toEqual(['LID', 'PHONE_JID']);
    expect(outside?.evidence_identity_id).toBeNull();

    const phones = await pool.query<{ identity_value: string }>(
      `SELECT identity_value FROM observed_contact_identities
       WHERE session_id = $1 AND identity_type = 'PHONE' ORDER BY identity_value`,
      [INTEGRATION_SESSION_ID],
    );
    expect(phones.rows).toEqual([{ identity_value: '84970000001' }]);
    expect(await scoped.catchUpUnprojected(10)).toBe(0);
    expect(await drain()).toBe(2);
  });

  it('serializes late evidence catch-up with group member replacement', async () => {
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, is_admin, is_super_admin)
       VALUES ($1, $2, 'serialized-evidence@lid', 'serialized-evidence', false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    const owner = await pool.connect();
    await owner.query('BEGIN');
    await owner.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('contact-member-projection' || ':' || $1, 0)
       )`,
      [INTEGRATION_SESSION_ID],
    );
    const catchUp = projections.catchUpMissingEvidence(10);
    try {
      const outcome = await Promise.race([
        catchUp.then(() => 'completed'),
        new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 50)),
      ]);
      expect(outcome).toBe('blocked');
    } finally {
      await owner.query('ROLLBACK');
      owner.release();
    }
    expect(await catchUp).toBe(1);
  });

  it('switches member search and ordering to completed shadow rows only when enabled', async () => {
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, display_name,
          shadow_display_name, shadow_display_name_source, shadow_sort_value,
          shadow_projection_revision, is_admin, is_super_admin)
       VALUES
         ($1, $2, 'a@lid', 'a', 'Legacy Alpha', 'Zulu', 'OPENWA_PUSH_NAME', 'zulu', 10, false, false),
         ($1, $2, 'b@lid', 'b', 'Legacy Beta', 'Alpha', 'OPENWA_PUSH_NAME', 'alpha', 11, false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    const legacy = new GatewayRepository(database, contacts, false);
    const shadow = new GatewayRepository(database, contacts, true);

    expect((await legacy.listMembers(
      INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, 10, 0, 'Legacy Alpha',
    )).total).toBe(1);
    expect((await shadow.listMembers(
      INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, 10, 0, 'Legacy Alpha',
    )).total).toBe(0);
    const page = await shadow.listMembers(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, 10, 0);
    expect(page.data.map(member => member.displayName)).toEqual(['Alpha', 'Zulu']);
    expect(page.datasetRevision).toBeGreaterThan(0);
    expect(page.data[0]).toMatchObject({
      participantId: 'b@lid',
      identityType: null,
      resolvedPhoneNumber: null,
      displayNameSource: 'OPENWA_PUSH_NAME',
      projectionRevision: 11,
    });

    const initialDatasetRevision = page.datasetRevision;
    await pool.query(
      `UPDATE group_members SET shadow_display_name = 'Aardvark', shadow_sort_value = 'aardvark'
       WHERE session_id = $1 AND group_id = $2 AND participant_id = 'a@lid'`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    const updated = await shadow.listMembers(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, 10, 0);
    expect(updated.datasetRevision).toBeGreaterThan(initialDatasetRevision);

    await pool.query(
      `DELETE FROM group_members
       WHERE session_id = $1 AND group_id = $2 AND participant_id = 'b@lid'`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    const deleted = await shadow.listMembers(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID, 10, 0);
    expect(deleted.datasetRevision).toBeGreaterThan(updated.datasetRevision);
  });

  it('keeps inbound observation completion independent from membership fan-out', async () => {
    await pool.query(
      `INSERT INTO group_members
         (session_id, group_id, participant_id, phone_number, display_name,
          display_name_source, is_admin, is_super_admin)
       VALUES ($1, $2, 'async@lid', 'async', 'Legacy marker',
         'GROUP_PARTICIPANT_NAME', false, false)`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    const asyncContacts = new ContactRepository(database, true, 30, evidence, false);
    await database.transaction(client => asyncContacts.seedGroupMembers(
      client,
      INTEGRATION_SESSION_ID,
      INTEGRATION_GROUP_ID,
      [{ id: 'async@lid', number: 'async', name: null, isAdmin: false, isSuperAdmin: false }],
    ));
    expect(await asyncContacts.observeMessageSender(
      INTEGRATION_SESSION_ID,
      'async@lid',
      'Async push',
      new Date('2026-08-14T06:03:00.000Z'),
      'message:async-fanout',
    )).toBe(true);
    const beforeWorker = await pool.query<{ display_name: string }>(
      `SELECT display_name FROM group_members
       WHERE session_id = $1 AND group_id = $2 AND participant_id = 'async@lid'`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(beforeWorker.rows[0]?.display_name).toBe('Legacy marker');

    const mirror = new ContactProjectionRepository(database, true);
    for (;;) {
      const claim = await mirror.claim();
      if (!claim) break;
      const result = await mirror.projectBatch(claim, 10);
      if (!result.completed) await mirror.release(claim);
    }
    const afterWorker = await pool.query<{
      display_name: string;
      shadow_display_name: string;
    }>(
      `SELECT display_name, shadow_display_name FROM group_members
       WHERE session_id = $1 AND group_id = $2 AND participant_id = 'async@lid'`,
      [INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID],
    );
    expect(afterWorker.rows[0]).toEqual({
      display_name: 'Async push',
      shadow_display_name: 'Async push',
    });
  });
});
