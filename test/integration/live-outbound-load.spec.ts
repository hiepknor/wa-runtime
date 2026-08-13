import { Logger } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DatabaseService } from '../../src/core/database/database.service';
import { runtimeConfig } from '../../src/core/config/runtime-config';
import { OpenWAClient } from '../../src/integrations/openwa/openwa.client';
import { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import { ContactRepository } from '../../src/modules/contacts/contact.repository';
import { SessionScopeService } from '../../src/modules/gateway/session-scope.service';
import { messageRequestHash } from '../../src/modules/messages/message-idempotency';
import { MessageJobProcessorService } from '../../src/modules/messages/message-job-processor.service';
import { MessageJobRepository } from '../../src/modules/messages/message-job.repository';
import { MessageSendPolicyService } from '../../src/modules/messages/message-send-policy.service';
import { OutboundSessionLeaseRepository } from '../../src/modules/messages/outbound-session-lease.repository';
import { OutboundSessionLeaseService } from '../../src/modules/messages/outbound-session-lease.service';
import {
  INTEGRATION_SESSION_ID,
  integrationPool,
  resetIntegrationDatabase,
  seedSendableGroup,
} from '../support/integration-database';

interface FakeOpenWAStats {
  sendCalls: number;
  activeSends: number;
  maximumConcurrentSends: number;
  duplicateRecipients: number;
}

describe('live outbound load', () => {
  it('sends 500 distinct jobs exactly once and serializes one session across worker replicas', async () => {
    Logger.overrideLogger([]);
    const pool = integrationPool();
    const databases = [new DatabaseService(), new DatabaseService()];
    try {
      await resetIntegrationDatabase(pool);
      await seedSendableGroup(pool);
      await resetFakeOpenWA();
      const groupIds = Array.from({ length: 500 }, (_, index) =>
        `live-load-${String(index + 1).padStart(4, '0')}@g.us`);
      await pool.query(
        `INSERT INTO gateway_groups
           (session_id, id, name, is_admin, is_read_only, is_announce, is_active,
            details_synced_at, send_capability, send_capability_reason, capability_checked_at)
         SELECT $1, item.id, 'Live load ' || item.ordinality, true, false, false, true,
           now(), 'ALLOWED', 'SEND_ALLOWED', now()
         FROM unnest($2::text[]) WITH ORDINALITY AS item(id, ordinality)`,
        [INTEGRATION_SESSION_ID, groupIds],
      );

      const messages = new MessageJobRepository(databases[0]!);
      await Promise.all(groupIds.map((recipientId, index) => {
        const text = `live-load-${index + 1}`;
        return messages.create({
          idempotencyScope: 'live-load',
          idempotencyKey: String(index + 1),
          requestHash: messageRequestHash({
            sessionId: INTEGRATION_SESSION_ID, recipientId, text, scheduledAt: null, dryRun: false,
          }),
          sessionId: INTEGRATION_SESSION_ID,
          recipientId,
          text,
          scheduledAt: new Date(Date.now() - 1_000),
          dryRun: false,
        });
      }));
      const claimed = await messages.claimDue(500);
      expect(claimed).toHaveLength(500);

      const processors = databases.map(database => {
        const processorMessages = new MessageJobRepository(database);
        const gateway = new GatewayRepository(database, new ContactRepository(database));
        return new MessageJobProcessorService(
          database,
          processorMessages,
          new MessageSendPolicyService(gateway, new SessionScopeService()),
          new OpenWAClient(),
          gateway,
          new OutboundSessionLeaseService(
            new OutboundSessionLeaseRepository(database),
            processorMessages,
          ),
        );
      });
      let next = 0;
      const consume = async (processor: MessageJobProcessorService): Promise<void> => {
        while (next < claimed.length) {
          const job = claimed[next++];
          if (job) await processor.process({ messageJobId: job.id });
        }
      };
      const startedAt = Date.now();
      await Promise.all(processors.map(consume));
      const durationMs = Date.now() - startedAt;

      const stats = await fakeOpenWAStats();
      const durable = await pool.query<{ accepted: string; attempts: string; distinct_jobs: string }>(
        `SELECT
           count(*) FILTER (WHERE mj.status = 'ACCEPTED')::text AS accepted,
           count(ma.id)::text AS attempts,
           count(DISTINCT ma.message_job_id)::text AS distinct_jobs
         FROM message_jobs mj LEFT JOIN message_attempts ma ON ma.message_job_id = mj.id
         WHERE mj.idempotency_scope = 'live-load'`,
      );
      expect(stats).toEqual({
        sendCalls: 500,
        activeSends: 0,
        maximumConcurrentSends: 1,
        duplicateRecipients: 0,
      });
      expect(durable.rows[0]).toEqual({ accepted: '500', attempts: '500', distinct_jobs: '500' });
      expect(durationMs).toBeLessThan(30_000);
    } finally {
      await Promise.all(databases.map(database => database.onApplicationShutdown()));
      await resetIntegrationDatabase(pool);
      await pool.end();
      Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose', 'fatal']);
    }
  }, 120_000);
});

async function resetFakeOpenWA(): Promise<void> {
  const response = await fetch(new URL('/__test/reset', runtimeConfig().OPENWA_BASE_URL), { method: 'POST' });
  if (!response.ok) throw new Error(`Unable to reset fake OpenWA: HTTP ${response.status}`);
}

async function fakeOpenWAStats(): Promise<FakeOpenWAStats> {
  const response = await fetch(new URL('/__test/stats', runtimeConfig().OPENWA_BASE_URL));
  if (!response.ok) throw new Error(`Unable to read fake OpenWA stats: HTTP ${response.status}`);
  return await response.json() as FakeOpenWAStats;
}
