import { DatabaseService } from '../../core/database/database.service';
import { ContactEvidenceWriter } from './contact-evidence.writer';

export class ContactSnapshotLifecycleRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly snapshotStagingEnabled: boolean,
    private readonly snapshotRetentionDays: number,
    private readonly evidenceWriter: ContactEvidenceWriter,
  ) {}

  async begin(sessionId: string, force = true): Promise<{
    generation: number;
    leaseToken: string;
  } | null> {
    const claimSql = `INSERT INTO contact_sync_state
         (session_id, sync_generation, last_started_at, last_error_code, lease_token, lease_expires_at)
       VALUES ($1, 1, now(), NULL, gen_random_uuid(), now() + interval '10 minutes')
       ON CONFLICT (session_id) DO UPDATE SET
         sync_generation = contact_sync_state.sync_generation + 1,
         last_started_at = now(), last_error_code = NULL,
         attempt_count = contact_sync_state.attempt_count + 1,
         lease_token = gen_random_uuid(), lease_expires_at = now() + interval '10 minutes', updated_at = now()
       WHERE (contact_sync_state.lease_token IS NULL OR contact_sync_state.lease_expires_at < now())
         AND ($2 OR contact_sync_state.next_attempt_at <= now())
       RETURNING sync_generation, lease_token`;
    if (!this.snapshotStagingEnabled) {
      const result = await this.database.query<{ sync_generation: string; lease_token: string }>(
        claimSql,
        [sessionId, force],
      );
      const row = result.rows[0];
      return row ? { generation: Number(row.sync_generation), leaseToken: row.lease_token } : null;
    }
    return this.database.transaction(async client => {
      const result = await client.query<{ sync_generation: string; lease_token: string }>(
        claimSql,
        [sessionId, force],
      );
      const row = result.rows[0];
      if (!row) return null;
      await client.query(
        `UPDATE contact_snapshot_generations
         SET state = 'FAILED', failed_at = now(), error_code = 'LEASE_EXPIRED', updated_at = now()
         WHERE session_id = $1 AND state = 'RECEIVING' AND generation < $2`,
        [sessionId, row.sync_generation],
      );
      await client.query(
        `DELETE FROM contact_snapshot_generations generation_state
         WHERE generation_state.session_id = $1
           AND generation_state.state IN ('PUBLISHED', 'FAILED')
           AND generation_state.created_at < now() - $2 * interval '1 day'
           AND generation_state.generation <> COALESCE((
             SELECT max(published.generation) FROM contact_snapshot_generations published
             WHERE published.session_id = $1 AND published.state = 'PUBLISHED'
           ), -1)
           AND generation_state.generation <> COALESCE((
             SELECT resolved.source_generation FROM contact_resolution_runs resolved
             WHERE resolved.session_id = $1 AND resolved.status = 'COMPLETED'
             ORDER BY resolved.completed_at DESC, resolved.id DESC LIMIT 1
           ), -1)`,
        [sessionId, this.snapshotRetentionDays],
      );
      await client.query(
        `INSERT INTO contact_snapshot_generations
           (session_id, generation, state, lease_token)
         VALUES ($1, $2, 'RECEIVING', $3)`,
        [sessionId, row.sync_generation, row.lease_token],
      );
      return { generation: Number(row.sync_generation), leaseToken: row.lease_token };
    });
  }

  async complete(
    sessionId: string,
    generation: number,
    leaseToken: string,
    records: number,
    intervalMs: number,
  ): Promise<void> {
    const completionSql = `UPDATE contact_sync_state SET last_completed_at = now(), last_successful_record_count = $3,
         last_error_code = NULL, attempt_count = 0,
         next_attempt_at = now() + $5 * interval '1 millisecond',
         lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE session_id = $1 AND sync_generation = $2 AND lease_token = $4
         AND lease_expires_at > now()`;
    const values = [sessionId, generation, records, leaseToken, intervalMs];
    if (!this.snapshotStagingEnabled) {
      const result = await this.database.query(completionSql, values);
      if (result.rowCount !== 1) throw new Error('Contact snapshot lost write ownership');
      return;
    }
    await this.database.transaction(async client => {
      const ownership = await client.query(
        `SELECT 1 FROM contact_sync_state
         WHERE session_id = $1 AND sync_generation = $2 AND lease_token = $3
           AND lease_expires_at > now()
         FOR UPDATE`,
        [sessionId, generation, leaseToken],
      );
      if (ownership.rowCount !== 1) throw new Error('Contact snapshot lost write ownership');
      await this.evidenceWriter.publishSnapshot(client, sessionId, generation);
      const generationResult = await client.query(
        `UPDATE contact_snapshot_generations generation_state
         SET state = 'PUBLISHED',
           upstream_record_count = $3,
           staged_identity_count = (
             SELECT count(*) FROM contact_snapshot_observations observation
             WHERE observation.session_id = $1 AND observation.generation = $2
           ),
           published_at = now(), updated_at = now()
         WHERE generation_state.session_id = $1 AND generation_state.generation = $2
           AND generation_state.state = 'RECEIVING' AND generation_state.lease_token = $4`,
        values.slice(0, 4),
      );
      if (generationResult.rowCount !== 1) throw new Error('Contact snapshot lost publication ownership');
      const completion = await client.query(completionSql, values);
      if (completion.rowCount !== 1) throw new Error('Contact snapshot lost write ownership');
    });
  }

  async fail(sessionId: string, generation: number, leaseToken: string, code: string): Promise<void> {
    const failureSql = `WITH evidence_cleanup AS (
         DELETE FROM contact_identity_evidence WHERE session_id = $1 AND sync_generation = $2
       )
       UPDATE contact_sync_state SET last_error_code = $4,
         next_attempt_at = now() + LEAST(3600, 60 * power(2, LEAST(attempt_count, 6))) * interval '1 second',
         lease_token = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE session_id = $1 AND sync_generation = $2 AND lease_token = $3`;
    const values = [sessionId, generation, leaseToken, code];
    if (!this.snapshotStagingEnabled) {
      await this.database.query(failureSql, values);
      return;
    }
    await this.database.transaction(async client => {
      await client.query(
        `UPDATE contact_snapshot_generations
         SET state = 'FAILED', failed_at = now(), error_code = $4, updated_at = now()
         WHERE session_id = $1 AND generation = $2 AND lease_token = $3
           AND state = 'RECEIVING'`,
        values,
      );
      await client.query(failureSql, values);
    });
  }
}
