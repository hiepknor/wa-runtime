import { Injectable, Logger } from '@nestjs/common';
import { runtimeConfig } from '../../core/config/runtime-config';
import { withCorrelationContext } from '../../core/observability/correlation-context';
import { RUNTIME_HEARTBEAT_INTERVAL_MS } from '../../core/queue/runtime-heartbeat';
import { QueueService } from '../../core/queue/queue.service';
import { CampaignDispatchTick } from './campaign-dispatch.tick';
import { DataRetentionTick } from './data-retention.tick';
import { GatewayDispatchTick } from './gateway-dispatch.tick';
import { IsolatedSchedulerTick } from './isolated-scheduler-tick';
import { MessageDispatchTick } from './message-dispatch.tick';
import { WebhookDispatchTick } from './webhook-dispatch.tick';
import { GatewayWorkListenerService } from './gateway-work-listener.service';

@Injectable()
export class SchedulerRunnerService {
  private readonly logger = new Logger(SchedulerRunnerService.name);
  private readonly config = runtimeConfig();

  constructor(
    private readonly messages: MessageDispatchTick,
    private readonly webhooks: WebhookDispatchTick,
    private readonly gateway: GatewayDispatchTick,
    private readonly campaigns: CampaignDispatchTick,
    private readonly retention: DataRetentionTick,
    private readonly queues: QueueService,
    private readonly gatewayListener: GatewayWorkListenerService,
  ) {}

  async run(): Promise<void> {
    const gatewayTick = this.tick(
      'gateway', this.config.GATEWAY_SYNC_POLL_INTERVAL_MS, 60_000, () => this.gateway.run(),
    );
    const ticks = [
      this.tick('messages', 1_000, 30_000, () => this.messages.run()),
      this.tick('webhooks', 1_000, 30_000, () => this.webhooks.run()),
      gatewayTick,
      this.tick('campaigns', 1_000, 30_000, () => this.campaigns.run()),
      this.tick(
        'retention',
        this.config.RUNTIME_RETENTION_INTERVAL_MS,
        5 * 60_000,
        () => this.retention.run(),
      ),
    ];
    let resolveStop: (() => void) | undefined;
    const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
    const stop = () => resolveStop?.();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    const heartbeat = setInterval(() => void this.publishHeartbeat(), RUNTIME_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    await this.publishHeartbeat();
    for (const tick of ticks) tick.start();
    await this.gatewayListener.start(() => gatewayTick.execute());

    await stopped;
    await this.gatewayListener.stop();
    await Promise.all(ticks.map(tick => tick.stop()));
    clearInterval(heartbeat);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }

  private tick(
    name: string,
    intervalMs: number,
    timeoutMs: number,
    operation: () => Promise<void>,
  ): IsolatedSchedulerTick {
    return new IsolatedSchedulerTick({
      name,
      intervalMs,
      timeoutMs,
      maxBackoffMs: Math.max(60_000, intervalMs * 8),
      operation: () => withCorrelationContext({ tick: name }, operation),
      report: state => this.queues.publishSchedulerTickState(state),
      logger: this.logger,
    });
  }

  private async publishHeartbeat(): Promise<void> {
    try {
      await this.queues.publishHeartbeat('scheduler');
    } catch (error) {
      this.logger.error({ event: 'runtime.heartbeat.failed', process: 'scheduler', error });
    }
  }
}
