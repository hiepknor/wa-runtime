import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseService } from '../../src/core/database/database.service';
import { OpenWAClient, OpenWAHttpError } from '../../src/integrations/openwa/openwa.client';
import { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import { ContactRepository } from '../../src/modules/contacts/contact.repository';
import { SessionScopeService } from '../../src/modules/gateway/session-scope.service';
import { messageRequestHash } from '../../src/modules/messages/message-idempotency';
import { MessageJobProcessorService } from '../../src/modules/messages/message-job-processor.service';
import { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import { MessageSendPolicyService } from '../../src/modules/messages/message-send-policy.service';
import { OutboundSessionLeaseRepository } from '../../src/modules/messages/outbound-session-lease.repository';
import { OutboundSessionLeaseService } from '../../src/modules/messages/outbound-session-lease.service';
import { INTEGRATION_GROUP_ID, INTEGRATION_SESSION_ID, integrationPool, resetIntegrationDatabase, seedSendableGroup } from '../support/integration-database';

describe('message durability and delivery', () => {
  let pool: Pool;
  let database: DatabaseService;
  let messages: MessageJobRepository;
  let outboundSessions: OutboundSessionLeaseService;

  beforeAll(() => {
    pool = integrationPool();
    database = new DatabaseService();
    messages = new MessageJobRepository(database);
    outboundSessions = new OutboundSessionLeaseService(
      new OutboundSessionLeaseRepository(database),
      messages,
    );
  });

  beforeEach(async () => {
    await resetIntegrationDatabase(pool);
    await seedSendableGroup(pool);
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
    await pool.end();
  });

  const create = (key: string, text: string, dryRun = true) => messages.create({
    idempotencyScope: 'runtime-api', idempotencyKey: key,
    requestHash: messageRequestHash({
      sessionId: INTEGRATION_SESSION_ID, recipientId: INTEGRATION_GROUP_ID, text, scheduledAt: null, dryRun,
    }),
    sessionId: INTEGRATION_SESSION_ID, recipientId: INTEGRATION_GROUP_ID,
    text, scheduledAt: new Date(Date.now() - 1_000), dryRun,
  });

  it('binds an idempotency key to one request fingerprint', async () => {
    const first = await create('same-intent', 'hello');
    const repeated = await create('same-intent', 'hello');
    const conflicting = await create('same-intent', 'different');

    expect(first.created).toBe(true);
    expect(repeated).toMatchObject({ created: false, idempotencyConflict: false });
    expect(repeated.job.id).toBe(first.job.id);
    expect(conflicting).toMatchObject({ created: false, idempotencyConflict: true });
  });

  it('lets concurrent scheduler claims take disjoint rows', async () => {
    for (let index = 0; index < 20; index += 1) await create(`concurrent-${index}`, `message-${index}`);

    const [first, second] = await Promise.all([messages.claimDue(10), messages.claimDue(10)]);
    const ids = [...first, ...second].map(job => job.id);

    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(new Set(ids).size).toBe(20);
  });

  it('turns an expired PROCESSING lease into audited UNKNOWN state', async () => {
    const created = await create('expired-send', 'hello', false);
    await messages.claimDue(10);
    await messages.markProcessing(created.job.id);
    await pool.query(
      `UPDATE message_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [created.job.id],
    );

    expect(await messages.markExpiredProcessingUnknown()).toBe(1);
    expect(await messages.find(created.job.id)).toMatchObject({
      status: 'UNKNOWN', lastError: 'Processing lease expired; delivery outcome is unknown',
    });
    const attempt = await pool.query(
      'SELECT outcome, error FROM message_attempts WHERE message_job_id = $1', [created.job.id],
    );
    expect(attempt.rows[0]).toMatchObject({
      outcome: 'UNKNOWN', error: 'Processing lease expired; delivery outcome is unknown',
    });
  });

  it('sends through fake OpenWA and persists ACCEPTED with the upstream message ID', async () => {
    const created = await create('accepted-send', 'integration-success', false);
    await messages.claimDue(10);
    const gateway = new GatewayRepository(database, new ContactRepository(database));
    const processor = new MessageJobProcessorService(
      database, messages,
      new MessageSendPolicyService(gateway, new SessionScopeService()),
      new OpenWAClient(), gateway, outboundSessions,
    );

    const result = await processor.process({ messageJobId: created.job.id }) as { messageId: string };

    expect(result.messageId).toMatch(/^fake-/);
    expect(await messages.find(created.job.id)).toMatchObject({ status: 'ACCEPTED', openwaMessageId: result.messageId });
  });

  it('records a proven 403 failure and invalidates group capability', async () => {
    const created = await create('denied-send', 'simulate-403', false);
    await messages.claimDue(10);
    const gateway = new GatewayRepository(database, new ContactRepository(database));
    const processor = new MessageJobProcessorService(
      database, messages,
      new MessageSendPolicyService(gateway, new SessionScopeService()),
      new OpenWAClient(), gateway, outboundSessions,
    );

    await expect(processor.process({ messageJobId: created.job.id })).rejects.toBeInstanceOf(OpenWAHttpError);
    expect(await messages.find(created.job.id)).toMatchObject({ status: 'FAILED' });
    expect(await gateway.findGroup(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID)).toMatchObject({
      sendCapability: { status: 'UNKNOWN', reason: 'GATEWAY_PERMISSION_DENIED' },
    });
  });

  it('records a proven 404 failure and marks the group as changed', async () => {
    const created = await create('missing-group-send', 'simulate-404', false);
    await messages.claimDue(10);
    const gateway = new GatewayRepository(database, new ContactRepository(database));
    const processor = new MessageJobProcessorService(
      database, messages,
      new MessageSendPolicyService(gateway, new SessionScopeService()),
      new OpenWAClient(), gateway, outboundSessions,
    );

    await expect(processor.process({ messageJobId: created.job.id })).rejects.toMatchObject({ status: 404 });
    expect(await messages.find(created.job.id)).toMatchObject({ status: 'FAILED' });
    expect(await gateway.findGroup(INTEGRATION_SESSION_ID, INTEGRATION_GROUP_ID)).toMatchObject({
      sendCapability: { status: 'UNKNOWN', reason: 'GROUP_CHANGED' },
    });
  });

  it('records UNKNOWN when the connection drops after the upstream request starts', async () => {
    const created = await create('ambiguous-send', 'simulate-network-drop', false);
    await messages.claimDue(10);
    const gateway = new GatewayRepository(database, new ContactRepository(database));
    const processor = new MessageJobProcessorService(
      database, messages,
      new MessageSendPolicyService(gateway, new SessionScopeService()),
      new OpenWAClient(), gateway, outboundSessions,
    );

    await expect(processor.process({ messageJobId: created.job.id })).rejects.toBeInstanceOf(Error);
    expect(await messages.find(created.job.id)).toMatchObject({ status: 'UNKNOWN' });
    const attempts = await pool.query<{ outcome: string }>(
      'SELECT outcome FROM message_attempts WHERE message_job_id = $1', [created.job.id],
    );
    expect(attempts.rows).toEqual([{ outcome: 'UNKNOWN' }]);
  });

  it.each([
    ['an upstream 5xx', 'simulate-500'],
    ['an upstream request timeout', 'simulate-408'],
  ])('records UNKNOWN for %s after dispatch starts', async (_case, text) => {
    const created = await create(`ambiguous-${text}`, text, false);
    await messages.claimDue(10);
    const gateway = new GatewayRepository(database, new ContactRepository(database));
    const processor = new MessageJobProcessorService(
      database, messages,
      new MessageSendPolicyService(gateway, new SessionScopeService()),
      new OpenWAClient(), gateway, outboundSessions,
    );

    await expect(processor.process({ messageJobId: created.job.id })).rejects.toBeInstanceOf(OpenWAHttpError);
    expect(await messages.find(created.job.id)).toMatchObject({ status: 'UNKNOWN' });
    const attempts = await pool.query<{ outcome: string }>(
      'SELECT outcome FROM message_attempts WHERE message_job_id = $1', [created.job.id],
    );
    expect(attempts.rows).toEqual([{ outcome: 'UNKNOWN' }]);
  });
});
