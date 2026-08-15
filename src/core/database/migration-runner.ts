import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

const MIGRATION_LOCK_NAME = 'wa-runtime:schema-migrations';

export interface MigrationRunResult {
  applied: string[];
  checksumsBackfilled: string[];
}

const checksum = (contents: string): string => createHash('sha256').update(contents).digest('hex');

export async function runMigrations(pool: Pool, directory: string): Promise<MigrationRunResult> {
  const client = await pool.connect();
  let locked = false;
  const result: MigrationRunResult = { applied: [], checksumsBackfilled: [] };
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK_NAME]);
    locked = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');

    const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
    const availableFiles = new Set(files);
    const recorded = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations WHERE name LIKE '%.sql' ORDER BY name",
    );
    const missing = recorded.rows.find(row => !availableFiles.has(row.name));
    if (missing) throw new Error(`Applied migration file missing: ${missing.name}`);

    for (const file of files) {
      const contents = await readFile(resolve(directory, file), 'utf8');
      const currentChecksum = checksum(contents);
      const existing = await client.query<{ checksum: string | null }>(
        'SELECT checksum FROM schema_migrations WHERE name = $1', [file],
      );
      if (existing.rowCount) {
        const recordedChecksum = existing.rows[0]!.checksum;
        if (recordedChecksum === null) {
          await client.query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1', [file, currentChecksum]);
          result.checksumsBackfilled.push(file);
          continue;
        }
        if (recordedChecksum !== currentChecksum) {
          throw new Error(`Applied migration checksum mismatch: ${file}`);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(contents);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [file, currentChecksum],
        );
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return result;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_NAME]);
    client.release();
  }
}
