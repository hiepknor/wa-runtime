import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { runtimeConfig, type RuntimeConfig } from '../config/runtime-config';
import { RUNTIME_CONFIG } from '../config/runtime-config.module';
import { CAMPAIGN_QUEUE, GATEWAY_SYNC_QUEUE, MESSAGE_SEND_QUEUE, WEBHOOK_QUEUE } from './queue.constants';
import {
  RUNTIME_HEARTBEAT_TTL_SECONDS,
  runtimeHeartbeatKey,
  schedulerTickStateKey,
  type SchedulerTickState,
  type RuntimeProcessName,
} from './runtime-heartbeat';

export interface QueueReadiness {
  redis: true;
}

export type RuntimeProcessHealthStatus = 'healthy' | 'degraded';

export interface RuntimeProcessHealth {
  worker: RuntimeProcessHealthStatus;
  scheduler: RuntimeProcessHealthStatus;
}

@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private readonly connection: IORedis;
  private readonly healthConnection: IORedis;
  readonly messageSend: Queue;
  readonly webhookIngress: Queue;
  readonly gatewaySync: Queue;
  readonly campaign: Queue;

  constructor(@Inject(RUNTIME_CONFIG) config: RuntimeConfig = runtimeConfig()) {
    this.connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
    this.healthConnection = new IORedis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
    });
    this.messageSend = new Queue(MESSAGE_SEND_QUEUE, { connection: this.connection });
    this.webhookIngress = new Queue(WEBHOOK_QUEUE, { connection: this.connection });
    this.gatewaySync = new Queue(GATEWAY_SYNC_QUEUE, { connection: this.connection });
    this.campaign = new Queue(CAMPAIGN_QUEUE, { connection: this.connection });
    this.connection.on('error', error => this.logConnectionError('queue', error));
    this.healthConnection.on('error', error => this.logConnectionError('health', error));
  }

  async publishHeartbeat(processName: RuntimeProcessName): Promise<void> {
    await this.ensureHealthConnection();
    const value = new Date().toISOString();
    await this.healthConnection.set(runtimeHeartbeatKey(processName), value, 'EX', RUNTIME_HEARTBEAT_TTL_SECONDS);
  }

  async publishSchedulerTickState(state: SchedulerTickState): Promise<void> {
    await this.ensureHealthConnection();
    const value = JSON.stringify(state);
    const ttl = 7 * 24 * 60 * 60;
    await this.healthConnection.set(schedulerTickStateKey(state.name), value, 'EX', ttl);
  }

  async readiness(): Promise<QueueReadiness> {
    await this.ensureHealthConnection();
    const pong = await this.healthConnection.ping();
    if (pong !== 'PONG') throw new Error('Redis readiness check failed');
    return { redis: true };
  }

  async runtimeProcessHealth(): Promise<RuntimeProcessHealth> {
    await this.ensureHealthConnection();
    const [worker, scheduler] = await this.healthConnection.mget(
      runtimeHeartbeatKey('worker'),
      runtimeHeartbeatKey('scheduler'),
    );
    return {
      worker: worker ? 'healthy' : 'degraded',
      scheduler: scheduler ? 'healthy' : 'degraded',
    };
  }

  private async ensureHealthConnection(): Promise<void> {
    if (this.healthConnection.status === 'wait') await this.healthConnection.connect();
  }

  private logConnectionError(connection: 'queue' | 'health', error: Error): void {
    this.logger.warn({
      event: 'redis.connection.error',
      connection,
      code: 'code' in error && typeof error.code === 'string' ? error.code : undefined,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.messageSend.close(), this.webhookIngress.close(), this.gatewaySync.close(), this.campaign.close()]);
    this.connection.disconnect();
    this.healthConnection.disconnect();
  }
}
