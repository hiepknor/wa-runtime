import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import type { OpenWAContact } from '../../src/integrations/openwa/openwa.client';
import { ContactRepository } from '../../src/modules/contacts/contact.repository';
import {
  DISALLOWED_SESSION_ID,
  INTEGRATION_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
  seedSendableGroup,
} from '../support/integration-database';

const observedContact = (name = 'Snapshot contact'): OpenWAContact => ({
  id: '84970000000@c.us',
  number: '84970000000',
  name,
  pushName: 'Snapshot push',
  isMyContact: true,
  isBlocked: false,
  profilePicUrl: null,
});

describe('contact snapshot publication', () => {
  let pool: Pool;
  let database: DatabaseService;
  let repository: ContactRepository;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    repository = new ContactRepository(database, true);
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await seedSendableGroup(pool);
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
    await pool.end();
  });

  it('keeps observations receiving until completion publishes the generation atomically', async () => {
    const claim = await repository.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    expect(claim).not.toBeNull();

    await expect(repository.ingestObservedPage(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
      [observedContact()],
    )).resolves.toEqual({ observed: 1, enriched: 0 });
    await repository.ingestObservedPage(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
      [observedContact()],
    );

    const receiving = await pool.query<{
      state: string;
      observations: string;
      published_at: Date | null;
    }>(
      `SELECT generation_state.state, generation_state.published_at,
         count(observation.identity_value)::text AS observations
       FROM contact_snapshot_generations generation_state
       LEFT JOIN contact_snapshot_observations observation
         ON observation.session_id = generation_state.session_id
        AND observation.generation = generation_state.generation
       WHERE generation_state.session_id = $1 AND generation_state.generation = $2
       GROUP BY generation_state.state, generation_state.published_at`,
      [INTEGRATION_SESSION_ID, claim!.generation],
    );
    expect(receiving.rows[0]).toEqual({ state: 'RECEIVING', observations: '1', published_at: null });

    await repository.reconcileObservedIdentities(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
    );
    await repository.completeObservedSnapshot(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
      2,
      86_400_000,
    );

    const published = await pool.query<{
      state: string;
      upstream_record_count: number;
      staged_identity_count: number;
      published_at: Date;
    }>(
      `SELECT state, upstream_record_count, staged_identity_count, published_at
       FROM contact_snapshot_generations WHERE session_id = $1 AND generation = $2`,
      [INTEGRATION_SESSION_ID, claim!.generation],
    );
    expect(published.rows[0]).toMatchObject({
      state: 'PUBLISHED',
      upstream_record_count: 2,
      staged_identity_count: 1,
    });
    expect(published.rows[0]?.published_at).toBeInstanceOf(Date);
  });

  it('rejects contradictory observations for one identity and retains a failed generation', async () => {
    const claim = await repository.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    expect(claim).not.toBeNull();
    await repository.ingestObservedPage(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
      [observedContact('First value')],
    );

    await expect(repository.ingestObservedPage(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
      [observedContact('Contradictory value')],
    )).rejects.toThrow('conflicting identity observations');
    await repository.failObservedSnapshot(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
      'INVALID_RESPONSE',
    );

    const failed = await pool.query<{
      state: string;
      error_code: string;
      observations: string;
    }>(
      `SELECT generation_state.state, generation_state.error_code,
         count(observation.identity_value)::text AS observations
       FROM contact_snapshot_generations generation_state
       LEFT JOIN contact_snapshot_observations observation
         ON observation.session_id = generation_state.session_id
        AND observation.generation = generation_state.generation
       WHERE generation_state.session_id = $1 AND generation_state.generation = $2
       GROUP BY generation_state.state, generation_state.error_code`,
      [INTEGRATION_SESSION_ID, claim!.generation],
    );
    expect(failed.rows[0]).toEqual({
      state: 'FAILED',
      error_code: 'INVALID_RESPONSE',
      observations: '1',
    });
  });

  it('cannot publish after lease expiry or write through another session', async () => {
    const claim = await repository.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    expect(claim).not.toBeNull();
    await expect(repository.ingestObservedPage(
      DISALLOWED_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
      [observedContact()],
    )).rejects.toThrow('lost write ownership');

    await pool.query(
      `UPDATE contact_sync_state SET lease_expires_at = now() - interval '1 second'
       WHERE session_id = $1 AND sync_generation = $2`,
      [INTEGRATION_SESSION_ID, claim!.generation],
    );
    await expect(repository.completeObservedSnapshot(
      INTEGRATION_SESSION_ID,
      claim!.generation,
      claim!.leaseToken,
      0,
      86_400_000,
    )).rejects.toThrow('lost write ownership');

    const state = await pool.query<{ state: string; published_at: Date | null }>(
      `SELECT state, published_at FROM contact_snapshot_generations
       WHERE session_id = $1 AND generation = $2`,
      [INTEGRATION_SESSION_ID, claim!.generation],
    );
    expect(state.rows[0]).toEqual({ state: 'RECEIVING', published_at: null });

    const replacement = await repository.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    expect(replacement?.generation).toBe(claim!.generation + 1);
    const generations = await pool.query<{ generation: string; state: string; error_code: string | null }>(
      `SELECT generation::text, state, error_code FROM contact_snapshot_generations
       WHERE session_id = $1 ORDER BY generation`,
      [INTEGRATION_SESSION_ID],
    );
    expect(generations.rows).toEqual([
      { generation: String(claim!.generation), state: 'FAILED', error_code: 'LEASE_EXPIRED' },
      { generation: String(replacement!.generation), state: 'RECEIVING', error_code: null },
    ]);
  });

  it('does not create staging generations while the rollout flag is disabled', async () => {
    const legacyRepository = new ContactRepository(database, false);
    const claim = await legacyRepository.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    expect(claim).not.toBeNull();
    const staged = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM contact_snapshot_generations WHERE session_id = $1`,
      [INTEGRATION_SESSION_ID],
    );
    expect(staged.rows[0]?.count).toBe('0');
  });

  it('bounds terminal-generation retention while preserving the newest publication', async () => {
    const first = await repository.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    await repository.completeObservedSnapshot(
      INTEGRATION_SESSION_ID, first!.generation, first!.leaseToken, 0, 86_400_000,
    );
    const second = await repository.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    await repository.completeObservedSnapshot(
      INTEGRATION_SESSION_ID, second!.generation, second!.leaseToken, 0, 86_400_000,
    );
    await pool.query(
      `UPDATE contact_snapshot_generations SET created_at = now() - interval '31 days'
       WHERE session_id = $1`,
      [INTEGRATION_SESSION_ID],
    );

    const third = await repository.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    const retained = await pool.query<{ generation: string; state: string }>(
      `SELECT generation::text, state FROM contact_snapshot_generations
       WHERE session_id = $1 ORDER BY generation`,
      [INTEGRATION_SESSION_ID],
    );
    expect(retained.rows).toEqual([
      { generation: String(second!.generation), state: 'PUBLISHED' },
      { generation: String(third!.generation), state: 'RECEIVING' },
    ]);
  });

  it('preserves the generation owned by the latest resolution and cascades derived runs on deletion', async () => {
    const resolved = await repository.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    await repository.completeObservedSnapshot(
      INTEGRATION_SESSION_ID, resolved!.generation, resolved!.leaseToken, 0, 86_400_000,
    );
    const run = await pool.query<{ id: string }>(
      `INSERT INTO contact_resolution_runs
         (session_id, source_generation, evidence_cutoff_at, status, completed_at)
       VALUES ($1, $2, now(), 'COMPLETED', now()) RETURNING id`,
      [INTEGRATION_SESSION_ID, resolved!.generation],
    );
    const latest = await repository.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    await repository.completeObservedSnapshot(
      INTEGRATION_SESSION_ID, latest!.generation, latest!.leaseToken, 0, 86_400_000,
    );
    await pool.query(
      `UPDATE contact_snapshot_generations SET created_at = now() - interval '31 days'
       WHERE session_id = $1`,
      [INTEGRATION_SESSION_ID],
    );

    const receiving = await repository.beginObservedSnapshot(INTEGRATION_SESSION_ID);
    const retained = await pool.query<{ generation: string }>(
      `SELECT generation::text FROM contact_snapshot_generations
       WHERE session_id = $1 ORDER BY generation`,
      [INTEGRATION_SESSION_ID],
    );
    expect(retained.rows).toEqual([
      { generation: String(resolved!.generation) },
      { generation: String(latest!.generation) },
      { generation: String(receiving!.generation) },
    ]);

    await pool.query(
      `DELETE FROM contact_snapshot_generations WHERE session_id = $1 AND generation = $2`,
      [INTEGRATION_SESSION_ID, resolved!.generation],
    );
    const derived = await pool.query('SELECT 1 FROM contact_resolution_runs WHERE id = $1', [run.rows[0]!.id]);
    expect(derived.rowCount).toBe(0);
  });
});
