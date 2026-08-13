import { Injectable, Logger } from '@nestjs/common';
import { stableQueueJobId } from '../../core/queue/queue-job-id';
import { QueueService } from '../../core/queue/queue.service';
import { GatewayRepository } from '../gateway/gateway.repository';
import { GatewaySyncItemRepository } from '../gateway/gateway-sync-item.repository';
import { GatewayGroupIntentRepository } from '../gateway/gateway-group-intent.repository';

@Injectable()
export class GatewayDispatchTick {
  private readonly logger = new Logger(GatewayDispatchTick.name);
  private running: Promise<void> | undefined;
  private rerun = false;

  constructor(
    private readonly gateway: GatewayRepository,
    private readonly syncItems: GatewaySyncItemRepository,
    private readonly groupIntents: GatewayGroupIntentRepository,
    private readonly queues: QueueService,
  ) {}

  async run(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    const operation = this.runUntilSettled();
    this.running = operation;
    try {
      await operation;
    } finally {
      if (this.running === operation) this.running = undefined;
    }
  }

  private async runUntilSettled(): Promise<void> {
    do {
      this.rerun = false;
      await this.dispatchOnce();
    } while (this.rerun);
  }

  private async dispatchOnce(): Promise<void> {
    const recovered = await this.gateway.recoverExpiredSyncRuns();
    const recoveredItems = await this.syncItems.recoverExpired();
    const recoveredCapabilities = await this.gateway.recoverExpiredCapabilityRefreshes();
    const recoveredIntents = await this.groupIntents.recoverExpired();
    if (recovered > 0) this.logger.warn({ event: 'sync_runs.recovered', count: recovered });
    if (recoveredItems > 0) this.logger.warn({ event: 'gateway_sync_items.recovered', count: recoveredItems });
    if (recoveredCapabilities > 0) {
      this.logger.warn({ event: 'group_capability_refreshes.recovered', count: recoveredCapabilities });
    }
    if (recoveredIntents > 0) {
      this.logger.warn({ event: 'gateway_group_intents.recovered', count: recoveredIntents });
    }
    const syncRuns = await this.gateway.listPendingSyncRuns(100);
    for (const run of syncRuns) {
      try {
        await this.queues.gatewaySync.add('full-session-sync', { syncRunId: run.id, sessionId: run.sessionId }, {
          jobId: run.id, attempts: 1, removeOnComplete: true, removeOnFail: true,
        });
      } catch (error) {
        this.logger.error({
          event: 'queue.publish.failed', queue: 'gateway_sync', jobName: 'full-session-sync',
          syncRunId: run.id, sessionId: run.sessionId, error,
        });
        // The durable PENDING row is retried on the next tick.
      }
    }

    const items = await this.syncItems.listDispatchable(100);
    for (const item of items) {
      try {
        await this.queues.gatewaySync.add('reconcile-session-group', {
          itemId: item.id,
          syncRunId: item.syncRunId,
          sessionId: item.sessionId,
          groupId: item.groupId,
        }, {
          jobId: stableQueueJobId('group-reconciliation', item.id),
          priority: 10,
          delay: Math.max(0, item.availableAt.valueOf() - Date.now()),
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        });
      } catch (error) {
        this.logger.error({
          event: 'queue.publish.failed', queue: 'gateway_sync', jobName: 'reconcile-session-group',
          syncRunId: item.syncRunId, sessionId: item.sessionId, error,
        });
      }
    }

    const refreshes = await this.gateway.listGroupsNeedingCapabilityRefresh(100);
    for (const refresh of refreshes) {
      try {
        await this.queues.gatewaySync.add('refresh-group-capability', {
          sessionId: refresh.sessionId,
          groupId: refresh.groupId,
          expectedRevision: refresh.revision,
        }, {
          jobId: stableQueueJobId('group-capability', `${refresh.sessionId}:${refresh.groupId}:${refresh.revision}`),
          priority: 1,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        });
      } catch (error) {
        this.logger.error({
          event: 'queue.publish.failed', queue: 'gateway_sync', jobName: 'refresh-group-capability',
          sessionId: refresh.sessionId, error,
        });
        // Capability invalidation remains durable in PostgreSQL.
      }
    }

    const intents = await this.groupIntents.listDispatchable(100);
    for (const intent of intents) {
      try {
        await this.queues.gatewaySync.add('reconcile-targeted-group', intent, {
          jobId: stableQueueJobId(
            'targeted-group-reconciliation',
            `${intent.sessionId}:${intent.groupId}:${intent.requestedRevision}`,
          ),
          priority: 5,
          delay: Math.max(0, intent.availableAt.valueOf() - Date.now()),
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        });
      } catch (error) {
        this.logger.error({
          event: 'queue.publish.failed', queue: 'gateway_sync',
          jobName: 'reconcile-targeted-group', sessionId: intent.sessionId, error,
        });
      }
    }
  }
}
