import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { messageRequestHash } from '../../src/modules/messages/message-idempotency';
import { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import { OutboundSessionLeaseRepository } from '../../src/modules/messages/outbound-session-lease.repository';
import {
  OutboundSessionLeaseLostError,
  OutboundSessionLeaseService,
} from '../../src/modules/messages/outbound-session-lease.service';
import {
  INTEGRATION_GROUP_ID,
  INTEGRATION_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
  seedSendableGroup,
} from '../support/integration-database';

describe('PostgreSQL outbound session lease', () => {
  let pool: Pool;
  let databases: DatabaseService[];
  let messages: MessageJobRepository[];
  let leases: OutboundSessionLeaseRepository[];
  let sessions: OutboundSessionLeaseService[];

  beforeAll(() => {
    pool = integrationPool();
    databases = [new DatabaseService(), new DatabaseService()];
    messages = databases.map(database => new MessageJobRepository(database));
    leases = databases.map(database => new OutboundSessionLeaseRepository(database));
    sessions = databases.map((_database, index) => new OutboundSessionLeaseService(
      leases[index]!,
      messages[index]!,
    ));
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await seedSendableGroup(pool);
  });

  afterAll(async () => {
    await Promise.all(databases.map(database => database.onApplicationShutdown()));
    await pool.end();
  });

  it('serializes one session across independent database connections', async () => {
    const jobs = await createProcessingJobs(messages[0]!, 2);
    const order: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const operation = (name: string) => async (verifyForSend: () => Promise<void>) => {
      await verifyForSend();
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(`${name}:start`);
      await new Promise(resolve => setTimeout(resolve, 75));
      order.push(`${name}:end`);
      active -= 1;
    };

    await Promise.all([
      sessions[0]!.withLease(INTEGRATION_SESSION_ID, jobs[0]!, operation('first')),
      sessions[1]!.withLease(INTEGRATION_SESSION_ID, jobs[1]!, operation('second')),
    ]);

    expect(maximumActive).toBe(1);
    expect(order).toSatisfy(value =>
      value.join(',') === 'first:start,first:end,second:start,second:end'
      || value.join(',') === 'second:start,second:end,first:start,first:end');
  });

  it('rejects a send when ownership is lost immediately before the upstream boundary', async () => {
    const [jobId] = await createProcessingJobs(messages[0]!, 1);
    let upstreamStarted = false;

    await expect(sessions[0]!.withLease(
      INTEGRATION_SESSION_ID,
      jobId!,
      async verifyForSend => {
        await pool.query(
          `UPDATE outbound_session_leases SET lease_token = gen_random_uuid()
           WHERE session_id = $1`,
          [INTEGRATION_SESSION_ID],
        );
        await verifyForSend();
        upstreamStarted = true;
      },
    )).rejects.toBeInstanceOf(OutboundSessionLeaseLostError);
    expect(upstreamStarted).toBe(false);
  });

  it('allows different sessions to make progress concurrently', async () => {
    const secondSessionId = randomUUID();
    await seedSendableGroup(pool, secondSessionId);
    const [firstJob] = await createProcessingJobs(messages[0]!, 1);
    const [secondJob] = await createProcessingJobs(messages[1]!, 1, secondSessionId);
    let active = 0;
    let maximumActive = 0;
    const operation = async (verifyForSend: () => Promise<void>) => {
      await verifyForSend();
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 75));
      active -= 1;
    };

    await Promise.all([
      sessions[0]!.withLease(INTEGRATION_SESSION_ID, firstJob!, operation),
      sessions[1]!.withLease(secondSessionId, secondJob!, operation),
    ]);

    expect(maximumActive).toBe(2);
  });

  it('allows expiry takeover and fences stale renew and release operations', async () => {
    const sessionId = randomUUID();
    const staleJobId = randomUUID();
    const currentJobId = randomUUID();
    const staleToken = randomUUID();
    const currentToken = randomUUID();

    expect(await leases[0]!.tryAcquire(sessionId, staleJobId, staleToken, 45_000)).toBe(true);
    await pool.query(
      `UPDATE outbound_session_leases SET lease_expires_at = now() - interval '1 second'
       WHERE session_id = $1`,
      [sessionId],
    );
    expect(await leases[1]!.tryAcquire(sessionId, currentJobId, currentToken, 45_000)).toBe(true);
    expect(await leases[0]!.renew(sessionId, staleJobId, staleToken, 45_000)).toBe(false);
    expect(await leases[0]!.release(sessionId, staleJobId, staleToken)).toBe(false);
    expect(await leases[1]!.renew(sessionId, currentJobId, currentToken, 45_000)).toBe(true);
  });
});

async function createProcessingJobs(
  messages: MessageJobRepository,
  count: number,
  sessionId = INTEGRATION_SESSION_ID,
): Promise<string[]> {
  const created: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const key = randomUUID();
    const text = `lease-${index}`;
    const result = await messages.create({
      idempotencyScope: 'outbound-lease-test',
      idempotencyKey: key,
      requestHash: messageRequestHash({
        sessionId,
        recipientId: INTEGRATION_GROUP_ID,
        text,
        scheduledAt: null,
        dryRun: false,
      }),
      sessionId,
      recipientId: INTEGRATION_GROUP_ID,
      text,
      scheduledAt: new Date(Date.now() - 1_000),
      dryRun: false,
    });
    created.push(result.job.id);
  }
  await messages.claimDue(count);
  for (const id of created) expect(await messages.markProcessing(id)).not.toBeNull();
  return created;
}
