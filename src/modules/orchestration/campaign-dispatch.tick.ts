import { Injectable, Logger } from '@nestjs/common';
import { QueueService } from '../../core/queue/queue.service';
import { CampaignRunRepository } from '../campaigns/campaign-run.repository';

@Injectable()
export class CampaignDispatchTick {
  private readonly logger = new Logger(CampaignDispatchTick.name);

  constructor(
    private readonly runs: CampaignRunRepository,
    private readonly queues: QueueService,
  ) {}

  async run(): Promise<void> {
    const recovered = await this.runs.recoverExpiredPreparations();
    if (recovered > 0) this.logger.warn({ event: 'campaign_preparations.recovered', count: recovered });
    const preparing = await this.runs.listPreparing(100);
    for (const run of preparing) {
      try {
        await this.queues.campaign.add('prepare-run', { runId: run.id }, {
          jobId: `prepare-run-${run.id}`, attempts: 1,
          removeOnComplete: true, removeOnFail: true,
        });
      } catch (error) {
        this.logger.error({
          event: 'queue.publish.failed', queue: 'campaign', jobName: 'prepare-run',
          campaignRunId: run.id, error,
        });
        // PREPARING remains durable for the next tick.
      }
    }
    await this.runs.activateDueRuns();
    await this.runs.reconcileDeliveries();
    await this.runs.finalizeRuns(100);
    for (const runId of await this.runs.listRunningIds(100)) {
      try {
        await this.runs.materializePending(runId, 5);
      } catch (error) {
        this.logger.error({ event: 'campaign.materialization.failed', campaignRunId: runId, error });
        // Pending deliveries remain durable for the next tick.
      }
    }
  }
}
