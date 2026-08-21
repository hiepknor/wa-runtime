import { Inject, Injectable, Logger } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { withCorrelationContext } from '../../core/observability/correlation-context';
import { RUNTIME_HEARTBEAT_INTERVAL_MS } from '../../core/queue/runtime-heartbeat';
import { QueueService } from '../../core/queue/queue.service';
import { CampaignDispatchTick } from './campaign-dispatch.tick';
import { CampaignLifecycleAuditTick } from './campaign-lifecycle-audit.tick';
import { DataRetentionTick } from './data-retention.tick';
import { GatewayDispatchTick } from './gateway-dispatch.tick';
import { IsolatedSchedulerTick } from './isolated-scheduler-tick';
import { MessageDispatchTick } from './message-dispatch.tick';
import { WebhookDispatchTick } from './webhook-dispatch.tick';
import { GatewayWorkListenerService } from './gateway-work-listener.service';
import { ContactPeriodicSyncTick } from '../contacts/contact-periodic-sync.tick';
import { WebhookRegistrationReconciliationTick } from '../webhooks/webhook-registration-reconciliation.tick';
import { ContactMemberIdentityBackfillTick } from '../contacts/contact-member-identity-backfill.tick';
import { ContactResolutionTick } from '../contacts/contact-resolution.tick';
import { ContactProjectionTick } from '../contacts/contact-projection.tick';
import { SchedulerLeadershipService } from './scheduler-leadership.service';
import { ContactMessageObservationTick } from '../contacts/contact-message-observation.tick';

@Injectable()
export class SchedulerRunnerService {
  private readonly logger = new Logger(SchedulerRunnerService.name);
  constructor(
    private readonly messages: MessageDispatchTick,
    private readonly webhooks: WebhookDispatchTick,
    private readonly gateway: GatewayDispatchTick,
    private readonly campaigns: CampaignDispatchTick,
    private readonly campaignLifecycleAudit: CampaignLifecycleAuditTick,
    private readonly retention: DataRetentionTick,
    private readonly queues: QueueService,
    private readonly gatewayListener: GatewayWorkListenerService,
    private readonly contacts: ContactPeriodicSyncTick,
    private readonly webhookRegistrations: WebhookRegistrationReconciliationTick,
    private readonly contactMemberIdentityBackfill: ContactMemberIdentityBackfillTick,
    private readonly contactResolution: ContactResolutionTick,
    private readonly contactProjection: ContactProjectionTick,
    private readonly contactMessageObservations: ContactMessageObservationTick,
    private readonly leadership: SchedulerLeadershipService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async run(): Promise<void> {
    await this.leadership.acquire();
    this.logger.log({ event: 'scheduler.leadership.acquired' });
    const gatewayTick = this.tick(
      'gateway', this.config.GATEWAY_SYNC_POLL_INTERVAL_MS, 60_000, () => this.gateway.run(),
    );
    const ticks = [
      this.tick('messages', 1_000, 30_000, () => this.messages.run()),
      this.tick('webhooks', 1_000, 30_000, () => this.webhooks.run()),
      gatewayTick,
      this.tick('campaigns', 1_000, 30_000, () => this.campaigns.run()),
      this.tick('campaign-lifecycle-audit', 60_000, 30_000, () => this.campaignLifecycleAudit.run()),
      this.tick(
        'retention',
        this.config.RUNTIME_RETENTION_INTERVAL_MS,
        5 * 60_000,
        () => this.retention.run(),
      ),
      this.tick('contacts', 300_000, 15 * 60_000, () => this.contacts.run()),
      this.tick(
        'contact-member-identity-backfill',
        30_000,
        2 * 60_000,
        () => this.contactMemberIdentityBackfill.run(),
      ),
      this.tick(
        'contact-resolution',
        60_000,
        5 * 60_000,
        () => this.contactResolution.run(),
      ),
      this.tick(
        'contact-projection',
        5_000,
        60_000,
        () => this.contactProjection.run(),
      ),
      this.tick(
        'contact-message-observations',
        5_000,
        60_000,
        () => this.contactMessageObservations.run(),
      ),
      this.tick(
        'webhook-registration',
        this.config.OPENWA_WEBHOOK_RECONCILIATION_INTERVAL_MS,
        2 * 60_000,
        () => this.webhookRegistrations.run(),
      ),
    ];
    let resolveStop: (() => void) | undefined;
    const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
    const stop = () => resolveStop?.();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    let heartbeat: NodeJS.Timeout | undefined;
    let listenerStarted = false;
    try {
      heartbeat = setInterval(() => void this.publishHeartbeat(), RUNTIME_HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();
      await this.publishHeartbeat();
      for (const tick of ticks) tick.start();
      await this.gatewayListener.start(() => gatewayTick.execute());
      listenerStarted = true;

      const leadershipFailure = await Promise.race([
        stopped.then(() => null),
        this.leadership.waitForLoss(),
      ]);
      if (leadershipFailure) throw leadershipFailure;
    } finally {
      const cleanup = await Promise.allSettled([
        ...(listenerStarted ? [this.gatewayListener.stop()] : []),
        ...ticks.map(tick => tick.stop()),
      ]);
      for (const result of cleanup) {
        if (result.status === 'rejected') {
          this.logger.error({ event: 'scheduler.shutdown.failed', error: result.reason });
        }
      }
      if (heartbeat) clearInterval(heartbeat);
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      await this.leadership.release();
      this.logger.log({ event: 'scheduler.leadership.released' });
    }
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
