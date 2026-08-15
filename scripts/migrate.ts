import { resolve } from 'node:path';
import { Pool } from 'pg';
import { runtimeConfig } from '../src/core/config/runtime-config';
import { runMigrations } from '../src/core/database/migration-runner';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: runtimeConfig().DATABASE_URL, max: 1 });
  try {
    const directory = resolve(process.cwd(), 'migrations');
    const result = await runMigrations(pool, directory);
    for (const file of result.checksumsBackfilled) process.stdout.write(`Recorded checksum ${file}\n`);
    for (const file of result.applied) process.stdout.write(`Applied ${file}\n`);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
