import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { runMigrations } from '../../src/core/database/migration-runner';
import { integrationPool } from '../support/integration-database';

describe('migration runner', () => {
  const migrationName = '900_migration_runner_probe.sql';
  let pool: Pool;
  let directory: string;

  beforeAll(async () => {
    pool = integrationPool();
    directory = await mkdtemp(resolve(tmpdir(), 'wa-runtime-migrations-'));
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS migration_runner_probe');
    await pool.query('DELETE FROM schema_migrations WHERE name = $1', [migrationName]);
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  });

  it('serializes concurrent runners and applies a migration exactly once', async () => {
    await writeFile(resolve(directory, migrationName),
      'SELECT pg_sleep(0.1); CREATE TABLE migration_runner_probe (id integer);\n');

    const [first, second] = await Promise.all([
      runMigrations(pool, directory),
      runMigrations(pool, directory),
    ]);

    expect([...first.applied, ...second.applied]).toEqual([migrationName]);
    const record = await pool.query<{ checksum: string | null }>(
      'SELECT checksum FROM schema_migrations WHERE name = $1', [migrationName],
    );
    expect(record.rows[0]?.checksum).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('fails closed when an already-applied migration changes', async () => {
    await writeFile(resolve(directory, migrationName),
      'CREATE TABLE migration_runner_probe (id bigint);\n');

    await expect(runMigrations(pool, directory)).rejects.toThrow(
      `Applied migration checksum mismatch: ${migrationName}`,
    );
  });

  it('backfills checksums for legacy migration records once', async () => {
    await writeFile(resolve(directory, migrationName),
      'SELECT pg_sleep(0.1); CREATE TABLE migration_runner_probe (id integer);\n');
    await pool.query('UPDATE schema_migrations SET checksum = NULL WHERE name = $1', [migrationName]);

    const result = await runMigrations(pool, directory);

    expect(result).toEqual({ applied: [], checksumsBackfilled: [migrationName] });
    const record = await pool.query<{ checksum: string | null }>(
      'SELECT checksum FROM schema_migrations WHERE name = $1', [migrationName],
    );
    expect(record.rows[0]?.checksum).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('fails closed when an applied migration file is removed', async () => {
    await unlink(resolve(directory, migrationName));

    await expect(runMigrations(pool, directory)).rejects.toThrow(
      `Applied migration file missing: ${migrationName}`,
    );
  });
});
