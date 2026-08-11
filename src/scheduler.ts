import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CampaignRunRepository } from './campaigns/campaign-run.repository';
import { GatewayRepository } from './gateway/gateway.repository';
import { MessageJobRepository } from './messages/message-job.repository';
import { QueueService } from './queue/queue.service';

const POLL_INTERVAL_MS = 1_000;
const BATCH_SIZE = 100;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  const repository = app.get(MessageJobRepository);
  const queues = app.get(QueueService);
  const gateway = app.get(GatewayRepository);
  const campaignRuns = app.get(CampaignRunRepository);
  let stopping = false;

  const stop = () => {
    stopping = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  while (!stopping) {
    await repository.recoverStaleQueued();
    const jobs = await repository.claimDue(BATCH_SIZE);
    for (const job of jobs) {
      try {
        await queues.messageSend.add(
          'send-text',
          { messageJobId: job.id },
          { jobId: job.id, attempts: 1, removeOnComplete: 1000, removeOnFail: 5000 },
        );
      } catch (error) {
        await repository.resetQueued(job.id, error instanceof Error ? error.message : String(error));
      }
    }
    const syncRuns = await gateway.listPendingSyncRuns(BATCH_SIZE);
    for (const run of syncRuns) {
      try {
        await queues.gatewaySync.add(
          'full-session-sync',
          { syncRunId: run.id, sessionId: run.sessionId },
          { jobId: run.id, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 },
        );
      } catch {
        // Leave the durable run pending; the next scheduler pass retries the enqueue.
      }
    }
    const capabilityRefreshes = await gateway.listGroupsNeedingCapabilityRefresh(BATCH_SIZE);
    for (const refresh of capabilityRefreshes) {
      const safeGroupId = refresh.groupId.replace(/[^a-zA-Z0-9_-]/g, '_');
      try {
        await queues.gatewaySync.add(
          'refresh-group-capability',
          {
            sessionId: refresh.sessionId,
            groupId: refresh.groupId,
            expectedRevision: refresh.revision,
          },
          {
            jobId: `group-capability-${refresh.sessionId}-${refresh.revision}-${safeGroupId}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 3000 },
            removeOnComplete: true,
            removeOnFail: 5000,
          },
        );
      } catch {
        // Invalidation remains durable in PostgreSQL; a later pass retries the enqueue.
      }
    }
    const preparingRuns = await campaignRuns.listPreparing(BATCH_SIZE);
    for (const run of preparingRuns) {
      try {
        await queues.campaign.add(
          'prepare-run',
          { runId: run.id },
          { jobId: `prepare-run-${run.id}`, attempts: 3, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: true, removeOnFail: 5000 },
        );
      } catch {
        // PREPARING remains durable; a later scheduler pass retries the enqueue.
      }
    }
    await campaignRuns.activateDueRuns();
    const runningRunIds = await campaignRuns.listRunningIds(BATCH_SIZE);
    for (const runId of runningRunIds) {
      try {
        await campaignRuns.materializePending(runId, 5);
      } catch {
        // The run and pending deliveries remain durable for the next scheduler pass.
      }
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  await app.close();
}

bootstrap().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
