import { Inject, Injectable, Logger } from '@nestjs/common';
import { Client, type Notification } from 'pg';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';

const gatewayWorkChannel = 'wa_runtime_gateway_work';

export class GatewayWakeCoordinator {
  private wakeInFlight = false;
  private wakeAgain = false;

  constructor(
    private readonly wake: () => Promise<unknown>,
    private readonly failed: (error: unknown) => void,
  ) {}

  request(): void {
    if (this.wakeInFlight) {
      this.wakeAgain = true;
      return;
    }
    this.wakeInFlight = true;
    void this.wake()
      .catch(this.failed)
      .finally(() => {
        this.wakeInFlight = false;
        if (this.wakeAgain) {
          this.wakeAgain = false;
          this.request();
        }
      });
  }
}

@Injectable()
export class GatewayWorkListenerService {
  private readonly logger = new Logger(GatewayWorkListenerService.name);
  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig()) {}

  private client: Client | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = true;
  private reconnectAttempt = 0;
  private coordinator: GatewayWakeCoordinator | undefined;

  async start(wake: () => Promise<unknown>): Promise<void> {
    this.coordinator = new GatewayWakeCoordinator(
      wake,
      error => this.logger.error({ event: 'gateway.sync.wakeup.failed', error }),
    );
    if (!this.config.GATEWAY_SYNC_NOTIFY_WAKEUP_ENABLED || !this.stopped) return;
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const client = this.client;
    this.client = undefined;
    if (client) await client.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new Client({ connectionString: this.config.DATABASE_URL });
    client.on('notification', notification => this.onNotification(notification));
    client.on('error', error => {
      if (this.client !== client || this.stopped) return;
      this.logger.warn({ event: 'gateway.sync.listener.disconnected', error });
      this.client = undefined;
      void client.end().catch(() => undefined);
      this.scheduleReconnect();
    });
    client.on('end', () => {
      if (this.client !== client || this.stopped) return;
      this.client = undefined;
      this.scheduleReconnect();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${gatewayWorkChannel}`);
      if (this.stopped) {
        await client.end();
        return;
      }
      this.client = client;
      this.reconnectAttempt = 0;
      this.logger.log({ event: 'gateway.sync.listener.ready' });
      this.requestWake('reconnect');
    } catch (error) {
      await client.end().catch(() => undefined);
      if (!this.stopped) {
        this.logger.warn({ event: 'gateway.sync.listener.connect_failed', error });
        this.scheduleReconnect();
      }
    }
  }

  private onNotification(notification: Notification): void {
    if (notification.channel !== gatewayWorkChannel || notification.payload !== 'group-reconciliation') return;
    this.requestWake('notify');
  }

  private requestWake(source: 'notify' | 'reconnect'): void {
    if (!this.coordinator || this.stopped) return;
    this.logger.debug({ event: 'gateway.sync.wakeup', source });
    this.coordinator.request();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delayMs = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempt, 6));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delayMs);
    this.reconnectTimer.unref();
  }
}
