import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const docker = (args: string[]): string =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const waitFor = async (check: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  throw new Error('Timed out waiting for group-member integration infrastructure');
};

const mappedPort = (container: string, port: string): number => {
  const output = docker(['port', container, port]);
  const value = output.split('\n')[0]?.trim();
  const parsed = Number(value?.slice(value.lastIndexOf(':') + 1));
  if (!Number.isInteger(parsed)) throw new Error(`Unable to parse Docker port mapping: ${output}`);
  return parsed;
};

async function migrate(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const directory = resolve(process.cwd(), 'migrations');
    const files = (await readdir(directory)).filter(file => file.endsWith('.sql')).sort();
    for (const file of files) await pool.query(await readFile(resolve(directory, file), 'utf8'));
  } finally {
    await pool.end();
  }
}

async function waitForDatabase(databaseUrl: string): Promise<void> {
  await waitFor(async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    } finally {
      await pool.end().catch(() => undefined);
    }
  });
}

export default async function setup(): Promise<() => Promise<void>> {
  docker(['info']);
  const suffix = randomUUID().slice(0, 8);
  const postgres = `wa-runtime-groups-postgres-${suffix}`;
  const redis = `wa-runtime-groups-redis-${suffix}`;
  const containers: string[] = [];

  try {
    docker(['run', '--rm', '-d', '--name', postgres,
      '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=wa_runtime',
      '-p', '127.0.0.1::5432', 'postgres:17-alpine']);
    containers.push(postgres);
    docker(['run', '--rm', '-d', '--name', redis, '-p', '127.0.0.1::6379', 'redis:8-alpine']);
    containers.push(redis);

    await Promise.all([
      waitFor(() => {
        try { docker(['exec', postgres, 'pg_isready', '-U', 'postgres', '-d', 'wa_runtime']); return true; }
        catch { return false; }
      }),
      waitFor(() => {
        try { return docker(['exec', redis, 'redis-cli', 'ping']) === 'PONG'; }
        catch { return false; }
      }),
    ]);

    const databaseUrl = `postgresql://postgres:test@127.0.0.1:${mappedPort(postgres, '5432/tcp')}/wa_runtime`;
    const redisUrl = `redis://127.0.0.1:${mappedPort(redis, '6379/tcp')}`;
    await waitForDatabase(databaseUrl);
    await migrate(databaseUrl);

    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      RUNTIME_API_KEY: 'integration-runtime-key-0000000000000000',
      ENABLE_RUNTIME_DOCS: 'false',
      OPENWA_BASE_URL: 'http://127.0.0.1:1',
      OPENWA_API_KEY: 'integration-openwa-key',
      OPENWA_RELEASE_TAG: '0.22.0',
      OPENWA_WEBHOOK_SECRET: 'integration-webhook-secret-0000000000000',
      OPENWA_ALLOWED_SESSION_IDS: '00000000-0000-4000-8000-000000000001',
      ALLOW_LIVE_SENDS: 'false',
      OUTBOUND_MIN_DELAY_MS: '0',
      OUTBOUND_MAX_DELAY_MS: '0',
    });

    return async () => {
      for (const container of containers.reverse()) {
        try { docker(['stop', container]); } catch { /* already stopped */ }
      }
    };
  } catch (error) {
    for (const container of containers.reverse()) {
      try { docker(['stop', container]); } catch { /* best-effort cleanup */ }
    }
    throw error;
  }
}
