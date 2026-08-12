import { Injectable, Logger } from '@nestjs/common';
import { withCorrelationContext } from '../../core/observability/correlation-context';
import { RUNTIME_HEARTBEAT_INTERVAL_MS } from '../../core/queue/runtime-heartbeat';
import { QueueService } from '../../core/queue/queue.service';
import { CampaignDispatchTick } from './campaign-dispatch.tick';
import { DataRetentionTick } from './data-retention.tick';
import { GatewayDispatchTick } from './gateway-dispatch.tick';
import { MessageDispatchTick } from './message-dispatch.tick';
import { WebhookDispatchTick } from './webhook-dispatch.tick';

const POLL_INTERVAL_MS = 1_000;

@Injectable()
export class SchedulerRunnerService {
  private readonly logger = new Logger(SchedulerRunnerService.name);

  constructor(
    private readonly messages: MessageDispatchTick,
    private readonly webhooks: WebhookDispatchTick,
    private readonly gateway: GatewayDispatchTick,
    private readonly campaigns: CampaignDispatchTick,
    private readonly retention: DataRetentionTick,
    private readonly queues: QueueService,
  ) {}

  async run(): Promise<void> {
    let stopping = false;
    const stop = () => { stopping = true; };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    const heartbeat = setInterval(() => void this.publishHeartbeat(), RUNTIME_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    await this.publishHeartbeat();

    const ticks = [this.messages, this.webhooks, this.gateway, this.campaigns, this.retention];
    while (!stopping) {
      for (const tick of ticks) {
        try {
          await withCorrelationContext({ tick: tick.constructor.name }, () => tick.run());
        } catch (error) {
          withCorrelationContext({ tick: tick.constructor.name }, () =>
            this.logger.error({ event: 'scheduler.tick.failed', tick: tick.constructor.name, error }));
        }
      }
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    clearInterval(heartbeat);
  }

  private async publishHeartbeat(): Promise<void> {
    try {
      await this.queues.publishHeartbeat('scheduler');
    } catch (error) {
      this.logger.error({ event: 'runtime.heartbeat.failed', process: 'scheduler', error });
    }
  }
}
