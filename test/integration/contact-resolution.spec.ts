import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import type { OpenWAContact } from '../../src/integrations/openwa/openwa.client';
import { ContactEvidenceWriter } from '../../src/modules/contacts/contact-evidence.writer';
import { ContactResolutionRepository } from '../../src/modules/contacts/contact-resolution.repository';
import { ContactRepository } from '../../src/modules/contacts/contact.repository';
import {
  INTEGRATION_SESSION_ID,
  DISALLOWED_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
  seedSendableGroup,
} from '../support/integration-database';

const contact = (id: string, number: string, name: string | null = null): OpenWAContact => ({
  id,
  number,
  name,
  pushName: null,
  isMyContact: name !== null,
  isBlocked: false,
  profilePicUrl: null,
});

describe('versioned contact resolution', () => {
  let pool: Pool;
  let database: DatabaseService;
  let contacts: ContactRepository;
  let resolutions: ContactResolutionRepository;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    contacts = new ContactRepository(database, true, 30, new ContactEvidenceWriter(true));
    resolutions = new ContactResolutionRepository(database);
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await seedSendableGroup(pool);
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
    await pool.end();
  });

  const publish = async (observations: OpenWAContact[]) => {
    const claim = await contacts.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    await contacts.ingestObservedPage(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
      observations,
    );
    await contacts.completeObservedSnapshot(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
      observations.length,
      86_400_000,
    );
    return claim!;
  };

  it('only enqueues and claims published generations for allowlisted sessions', async () => {
    const scoped = new ContactResolutionRepository(database, false, [INTEGRATION_SESSION_ID]);
    await seedSendableGroup(pool, DISALLOWED_SESSION_ID);
    const allowed = await contacts.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    await contacts.completeObservedSnapshot(
      INTEGRATION_SESSION_ID, allowed!.generation, allowed!.leaseToken, 0, 86_400_000,
    );
    const disallowed = await contacts.beginObservedSnapshot(DISALLOWED_SESSION_ID);
    await contacts.completeObservedSnapshot(
      DISALLOWED_SESSION_ID, disallowed!.generation, disallowed!.leaseToken, 0, 86_400_000,
    );

    expect(await scoped.enqueuePublished(10)).toBe(1);
    await resolutions.enqueuePublished(10);
    await pool.query(
      `UPDATE contact_resolution_runs SET status = 'RUNNING',
         lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 second'
       WHERE session_id = $1`,
      [DISALLOWED_SESSION_ID],
    );
    const claim = await scoped.claim();
    expect(claim?.sessionId).toBe(INTEGRATION_SESSION_ID);
  });

  const resolveNext = async () => {
    await resolutions.enqueuePublished(10);
    const claim = await resolutions.claim();
    expect(claim).not.toBeNull();
    const result = await resolutions.resolve(claim!);
    return { claim: claim!, result };
  };

  const assignments = async (runId: string) => {
    const result = await pool.query<{
      identity_value: string;
      cluster_id: string;
      resolution_status: string;
      resolved_phone_number: string | null;
    }>(
      `SELECT identity.identity_value, assignment.cluster_id,
         assignment.resolution_status, assignment.resolved_phone_number
       FROM resolved_identity_assignments assignment
       JOIN observed_contact_identities identity
         ON identity.session_id = assignment.session_id AND identity.id = assignment.identity_id
       WHERE assignment.session_id = $1 AND assignment.run_id = $2
       ORDER BY identity.identity_value`,
      [INTEGRATION_SESSION_ID, runId],
    );
    return result.rows;
  };

  it('is deterministic across page order and can split a prior cluster without rewriting it', async () => {
    await publish([
      contact('84970000000@c.us', '84970000000', 'Saved contact'),
      contact('lid-a@lid', '84970000000'),
    ]);
    const first = await resolveNext();
    expect(first.result).toEqual({
      identities: 3,
      clusters: 1,
      linkedIdentities: 3,
      conflictIdentities: 0,
    });
    const firstCompletion = await pool.query<{
      completed_after_start: boolean;
      timestamps_match: boolean;
    }>(
      `SELECT completed_at > started_at AS completed_after_start,
         completed_at = updated_at AS timestamps_match
       FROM contact_resolution_runs WHERE session_id = $1 AND id = $2`,
      [INTEGRATION_SESSION_ID, first.claim.runId],
    );
    expect(firstCompletion.rows[0]).toEqual({
      completed_after_start: true,
      timestamps_match: true,
    });
    const firstAssignments = await assignments(first.claim.runId);
    expect(new Set(firstAssignments.map(row => row.cluster_id)).size).toBe(1);
    expect(firstAssignments.every(row => row.resolved_phone_number === '84970000000')).toBe(true);
    const firstCluster = await pool.query<{ contact_display_name: string }>(
      `SELECT contact_display_name FROM resolved_contact_clusters
       WHERE session_id = $1 AND run_id = $2`,
      [INTEGRATION_SESSION_ID, first.claim.runId],
    );
    expect(firstCluster.rows[0]?.contact_display_name).toBe('Saved contact');

    await publish([
      contact('lid-a@lid', '84970000000'),
      contact('84970000000@c.us', '84970000000', 'Saved contact'),
    ]);
    const second = await resolveNext();
    expect(await assignments(second.claim.runId)).toEqual(firstAssignments);

    await publish([
      contact('84970000000@c.us', '84970000000', 'Saved contact'),
      contact('lid-a@lid', '84971111111'),
    ]);
    const third = await resolveNext();
    expect(third.result).toMatchObject({ clusters: 2, conflictIdentities: 0 });
    const thirdAssignments = await assignments(third.claim.runId);
    const lid = thirdAssignments.find(row => row.identity_value === 'lid-a@lid');
    expect(lid).toMatchObject({
      resolution_status: 'RESOLVED',
      resolved_phone_number: '84971111111',
    });
    expect(await assignments(first.claim.runId)).toEqual(firstAssignments);
  });

  it('projects the first generation, skips an identical generation, and enqueues both sides of a split', async () => {
    const projected = new ContactResolutionRepository(database, true);
    const resolveProjected = async () => {
      await projected.enqueuePublished(10);
      const claim = await projected.claim();
      expect(claim).not.toBeNull();
      await projected.resolve(claim!);
    };

    await publish([
      contact('84970000000@c.us', '84970000000', 'Saved contact'),
      contact('lid-a@lid', '84970000000'),
    ]);
    await resolveProjected();
    expect((await pool.query(
      `SELECT 1 FROM contact_projection_work WHERE session_id = $1`,
      [INTEGRATION_SESSION_ID],
    )).rowCount).toBe(1);
    await pool.query('DELETE FROM contact_projection_work WHERE session_id = $1', [INTEGRATION_SESSION_ID]);

    await publish([
      contact('lid-a@lid', '84970000000'),
      contact('84970000000@c.us', '84970000000', 'Saved contact'),
    ]);
    await resolveProjected();
    expect((await pool.query(
      `SELECT 1 FROM contact_projection_work WHERE session_id = $1`,
      [INTEGRATION_SESSION_ID],
    )).rowCount).toBe(0);

    await publish([
      contact('84970000000@c.us', '84970000000', 'Saved contact'),
      contact('lid-a@lid', '84971111111'),
    ]);
    await resolveProjected();
    expect((await pool.query(
      `SELECT 1 FROM contact_projection_work WHERE session_id = $1`,
      [INTEGRATION_SESSION_ID],
    )).rowCount).toBe(2);
  });

  it('quarantines ambiguous LID mappings while keeping an exact phone JID resolvable', async () => {
    await publish([
      contact('84970000000@c.us', '84970000000'),
      contact('lid-a@lid', '84970000000'),
      contact('lid-b@lid', '84970000000'),
    ]);
    const run = await resolveNext();
    expect(run.result).toEqual({
      identities: 4,
      clusters: 3,
      linkedIdentities: 2,
      conflictIdentities: 2,
    });
    const rows = await assignments(run.claim.runId);
    expect(rows.filter(row => row.identity_value.endsWith('@lid'))).toEqual([
      expect.objectContaining({
        identity_value: 'lid-a@lid',
        resolution_status: 'QUARANTINED',
        resolved_phone_number: null,
      }),
      expect.objectContaining({
        identity_value: 'lid-b@lid',
        resolution_status: 'QUARANTINED',
        resolved_phone_number: null,
      }),
    ]);
    const conflicts = await pool.query<{ conflict_code: string; count: string }>(
      `SELECT conflict_code, count(*)::text AS count FROM contact_resolution_conflicts
       WHERE session_id = $1 AND run_id = $2 GROUP BY conflict_code`,
      [INTEGRATION_SESSION_ID, run.claim.runId],
    );
    expect(conflicts.rows).toEqual([{
      conflict_code: 'PHONE_SHARED_BY_MULTIPLE_NON_PHONE_IDENTITIES',
      count: '2',
    }]);
  });

  it('freezes the evidence cutoff and fences an expired resolver attempt', async () => {
    await publish([contact('84970000000@c.us', '84970000000')]);
    const existingIdentity = await pool.query<{ id: string }>(
      `SELECT id FROM observed_contact_identities
       WHERE session_id = $1 AND identity_type = 'PHONE_JID'`,
      [INTEGRATION_SESSION_ID],
    );
    await pool.query(
      `INSERT INTO contact_observations
         (session_id, identity_id, observation_source, observation_scope,
          name_value, source_observed_at, source_observation_key)
       VALUES ($1, $2, 'OPENWA_CONTACT_NAME', 'IDENTITY',
         'Late contact observation', '2026-08-01T00:00:00.000Z', 'late-existing-contact')`,
      [INTEGRATION_SESSION_ID, existingIdentity.rows[0]!.id],
    );
    await contacts.observeMessageSender(
      INTEGRATION_SESSION_ID,
      'late@lid',
      'Late observation',
      new Date('2026-08-14T05:00:00.000Z'),
      'late-after-publication',
    );
    await resolutions.enqueuePublished(10);
    const stale = await resolutions.claim();
    expect(stale).not.toBeNull();
    await pool.query(
      `UPDATE contact_resolution_runs SET lease_expires_at = now() - interval '1 second'
       WHERE session_id = $1 AND id = $2`,
      [INTEGRATION_SESSION_ID, stale!.runId],
    );
    await expect(resolutions.resolve(stale!)).rejects.toThrow('lost ownership');

    const current = await resolutions.claim();
    expect(current?.runId).toBe(stale!.runId);
    expect(current?.leaseToken).not.toBe(stale!.leaseToken);
    const result = await resolutions.resolve(current!);
    expect(result.identities).toBe(2);
    expect((await assignments(current!.runId)).some(row => row.identity_value === 'late@lid')).toBe(false);
    const clusterName = await pool.query<{ contact_display_name: string | null }>(
      `SELECT contact_display_name FROM resolved_contact_clusters
       WHERE session_id = $1 AND run_id = $2`,
      [INTEGRATION_SESSION_ID, current!.runId],
    );
    expect(clusterName.rows[0]?.contact_display_name).toBeNull();
  });
});
