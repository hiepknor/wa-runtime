import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const GROUP_ID = '120363000000000000@g.us';

const docker = (args: string[], options: { input?: string } = {}): string =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();

const waitFor = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for integration-test container');
};

const mappedPort = (container: string, port: string): number => {
  const output = docker(['port', container, port]);
  const value = output.split('\n')[0]?.trim();
  const parsed = Number(value?.slice(value.lastIndexOf(':') + 1));
  if (!Number.isInteger(parsed)) throw new Error(`Unable to parse Docker port mapping: ${output}`);
  return parsed;
};

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
};

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
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
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await pool.query('SELECT 1');
      await pool.end();
      return;
    } catch {
      await pool.end().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error('Timed out waiting for PostgreSQL host connection');
}

export default async function setup(): Promise<() => Promise<void>> {
  docker(['info']);
  const suffix = randomUUID().slice(0, 8);
  const postgres = `wa-runtime-test-postgres-${suffix}`;
  const redis = `wa-runtime-test-redis-${suffix}`;
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
    // The postgres image briefly exposes its bootstrap server before restarting into the final server.
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000));

    const postgresPort = mappedPort(postgres, '5432/tcp');
    const redisPort = mappedPort(redis, '6379/tcp');
    const databaseUrl = `postgresql://postgres:test@127.0.0.1:${postgresPort}/wa_runtime`;
    await waitForDatabase(databaseUrl);
    await migrate(databaseUrl);

    let sendCalls = 0;
    let activeSends = 0;
    let maximumConcurrentSends = 0;
    const sendsByChatId = new Map<string, number>();
    const fakeOpenWA = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const path = decodeURIComponent(url.pathname);
      if (request.method === 'POST' && path === '/__test/reset') {
        sendCalls = 0;
        activeSends = 0;
        maximumConcurrentSends = 0;
        sendsByChatId.clear();
        return json(response, 200, { reset: true });
      }
      if (request.method === 'GET' && path === '/__test/stats') {
        return json(response, 200, {
          sendCalls,
          activeSends,
          maximumConcurrentSends,
          duplicateRecipients: [...sendsByChatId.values()].filter(count => count > 1).length,
        });
      }
      if (request.method === 'GET' && path === '/api/health') {
        return json(response, 200, { status: 'ok', timestamp: new Date().toISOString(), version: '0.22.0' });
      }
      if (request.method === 'GET' && path === `/api/sessions/${SESSION_ID}`) {
        return json(response, 200, {
          id: SESSION_ID, name: 'Integration session', status: 'ready', engineLoaded: true,
          restriction: null, createdAt: '2026-08-11T00:00:00.000Z', updatedAt: '2026-08-11T00:00:00.000Z',
        });
      }
      if (request.method === 'GET' && path === `/api/sessions/${SESSION_ID}/groups`) {
        return json(response, 200, Number(url.searchParams.get('offset') ?? 0) === 0
          ? [{ id: GROUP_ID, name: 'Integration group', participantsCount: 1, isAdmin: true }]
          : []);
      }
      if (request.method === 'GET' && path === `/api/sessions/${SESSION_ID}/groups/${GROUP_ID}`) {
        return json(response, 200, {
          id: GROUP_ID, name: 'Integration group', participantsCount: 1, isAdmin: true,
          isReadOnly: false, announce: false,
          participants: [{ id: '84970000000@c.us', number: '84970000000', isAdmin: true, isSuperAdmin: false }],
        });
      }
      if (request.method === 'POST' && path === `/api/sessions/${SESSION_ID}/messages/send-text`) {
        const body = await readJson(request);
        const chatId = String(body.chatId ?? '');
        sendCalls += 1;
        activeSends += 1;
        maximumConcurrentSends = Math.max(maximumConcurrentSends, activeSends);
        sendsByChatId.set(chatId, (sendsByChatId.get(chatId) ?? 0) + 1);
        try {
          await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
          if (body.text === 'simulate-403') return json(response, 403, { message: 'permission denied' });
          if (body.text === 'simulate-404') return json(response, 404, { message: 'group not found' });
          if (body.text === 'simulate-500') return json(response, 500, { message: 'upstream failure' });
          if (body.text === 'simulate-408') return json(response, 408, { message: 'request timed out' });
          if (body.text === 'simulate-network-drop') {
            request.socket.destroy();
            return;
          }
          return json(response, 201, { messageId: `fake-${randomUUID()}`, timestamp: 1786406400 });
        } finally {
          activeSends -= 1;
        }
      }
      return json(response, 404, { message: 'not found' });
    });
    await new Promise<void>((resolveListen, reject) => {
      fakeOpenWA.once('error', reject);
      fakeOpenWA.listen(0, '127.0.0.1', resolveListen);
    });
    const address = fakeOpenWA.address();
    if (!address || typeof address === 'string') throw new Error('Fake OpenWA did not bind a TCP port');

    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      REDIS_URL: `redis://127.0.0.1:${redisPort}`,
      RUNTIME_API_KEY: 'integration-runtime-key-0000000000000000',
      ENABLE_RUNTIME_DOCS: 'false',
      OPENWA_BASE_URL: `http://127.0.0.1:${address.port}`,
      OPENWA_API_KEY: 'integration-openwa-key',
      OPENWA_RELEASE_TAG: '0.22.0',
      OPENWA_WEBHOOK_SECRET: 'integration-webhook-secret-0000000000000',
      OPENWA_ALLOWED_SESSION_IDS: SESSION_ID,
      ALLOW_LIVE_SENDS: 'true',
      OUTBOUND_MIN_DELAY_MS: '0',
      OUTBOUND_MAX_DELAY_MS: '0',
      GATEWAY_GROUP_EVENT_DEBOUNCE_MS: '0',
      GATEWAY_GROUP_EVENT_MAX_WAIT_MS: '1000',
      GATEWAY_TARGETED_RECONCILIATION_ENABLED: 'true',
      GATEWAY_SYNC_NOTIFY_WAKEUP_ENABLED: 'true',
      GATEWAY_SYNC_ADAPTIVE_PACING: 'true',
      GATEWAY_SYNC_MIN_GROUPS_PER_MINUTE: '5',
      GATEWAY_SYNC_RATE_RECOVERY_SUCCESSES: '2',
    });

    return async () => {
      await new Promise<void>(resolveClose => fakeOpenWA.close(() => resolveClose()));
      for (const container of containers.reverse()) {
        try { docker(['stop', container]); } catch { /* already stopped */ }
      }
    };
  } catch (error) {
    for (const container of containers.reverse()) {
      try { docker(['stop', container]); } catch { /* best-effort setup cleanup */ }
    }
    throw error;
  }
}
