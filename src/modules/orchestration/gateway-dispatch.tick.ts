import { Injectable, Logger } from '@nestjs/common';
import { stableQueueJobId } from '../../core/queue/queue-job-id';
import { QueueService } from '../../core/queue/queue.service';
import { GatewayRepository } from '../gateway/gateway.repository';

@Injectable()
export class GatewayDispatchTick {
  private readonly logger = new Logger(GatewayDispatchTick.name);

  constructor(
    private readonly gateway: GatewayRepository,
    private readonly queues: QueueService,
  ) {}

  async run(): Promise<void> {
    const recovered = await this.gateway.recoverExpiredSyncRuns();
    if (recovered > 0) this.logger.warn({ event: 'sync_runs.recovered', count: recovered });
    const syncRuns = await this.gateway.listPendingSyncRuns(100);
    for (const run of syncRuns) {
      try {
        await this.queues.gatewaySync.add('full-session-sync', { syncRunId: run.id, sessionId: run.sessionId }, {
          jobId: run.id, attempts: 3, backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 1000, removeOnFail: true,
        });
      } catch (error) {
        this.logger.error({
          event: 'queue.publish.failed', queue: 'gateway_sync', jobName: 'full-session-sync',
          syncRunId: run.id, sessionId: run.sessionId, error,
        });
        // The durable PENDING row is retried on the next tick.
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
          attempts: 3,
          backoff: { type: 'exponential', delay: 3000 },
          removeOnComplete: true,
          removeOnFail: true,
        });
      } catch (error) {
        this.logger.error({
          event: 'queue.publish.failed', queue: 'gateway_sync', jobName: 'refresh-group-capability',
          sessionId: refresh.sessionId, groupId: refresh.groupId, error,
        });
        // Capability invalidation remains durable in PostgreSQL.
      }
    }
  }
}
