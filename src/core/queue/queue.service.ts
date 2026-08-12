import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { runtimeConfig } from '../config/runtime-config';
import { CAMPAIGN_QUEUE, GATEWAY_SYNC_QUEUE, MESSAGE_SEND_QUEUE, WEBHOOK_QUEUE } from './queue.constants';
import {
  legacyRuntimeHeartbeatKey,
  legacySchedulerTickStateKey,
  RUNTIME_HEARTBEAT_TTL_SECONDS,
  runtimeHeartbeatKey,
  schedulerTickStateKey,
  type SchedulerTickState,
  type RuntimeProcessName,
} from './runtime-heartbeat';

export interface QueueReadiness {
  redis: true;
  worker: true;
  scheduler: true;
}

@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly connection = new IORedis(runtimeConfig().REDIS_URL, { maxRetriesPerRequest: null });
  private readonly healthConnection = new IORedis(runtimeConfig().REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 2_000,
  });
  readonly messageSend = new Queue(MESSAGE_SEND_QUEUE, { connection: this.connection });
  readonly webhookIngress = new Queue(WEBHOOK_QUEUE, { connection: this.connection });
  readonly gatewaySync = new Queue(GATEWAY_SYNC_QUEUE, { connection: this.connection });
  readonly campaign = new Queue(CAMPAIGN_QUEUE, { connection: this.connection });

  async publishHeartbeat(processName: RuntimeProcessName): Promise<void> {
    await this.ensureHealthConnection();
    const value = new Date().toISOString();
    await Promise.all([
      this.healthConnection.set(runtimeHeartbeatKey(processName), value, 'EX', RUNTIME_HEARTBEAT_TTL_SECONDS),
      this.healthConnection.set(legacyRuntimeHeartbeatKey(processName), value, 'EX', RUNTIME_HEARTBEAT_TTL_SECONDS),
    ]);
  }

  async publishSchedulerTickState(state: SchedulerTickState): Promise<void> {
    await this.ensureHealthConnection();
    const value = JSON.stringify(state);
    const ttl = 7 * 24 * 60 * 60;
    await Promise.all([
      this.healthConnection.set(schedulerTickStateKey(state.name), value, 'EX', ttl),
      this.healthConnection.set(legacySchedulerTickStateKey(state.name), value, 'EX', ttl),
    ]);
  }

  async readiness(): Promise<QueueReadiness> {
    await this.ensureHealthConnection();
    const pong = await this.healthConnection.ping();
    const [worker, scheduler, legacyWorker, legacyScheduler] = await this.healthConnection.mget(
      runtimeHeartbeatKey('worker'),
      runtimeHeartbeatKey('scheduler'),
      legacyRuntimeHeartbeatKey('worker'),
      legacyRuntimeHeartbeatKey('scheduler'),
    );
    const workerReady = worker ?? legacyWorker;
    const schedulerReady = scheduler ?? legacyScheduler;
    if (pong !== 'PONG' || !workerReady || !schedulerReady) {
      throw new Error(`Runtime process heartbeat missing: ${[
        !workerReady ? 'worker' : undefined,
        !schedulerReady ? 'scheduler' : undefined,
      ].filter(Boolean).join(', ') || 'redis'}`);
    }
    return { redis: true, worker: true, scheduler: true };
  }

  private async ensureHealthConnection(): Promise<void> {
    if (this.healthConnection.status === 'wait') await this.healthConnection.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.messageSend.close(), this.webhookIngress.close(), this.gatewaySync.close(), this.campaign.close()]);
    this.connection.disconnect();
    this.healthConnection.disconnect();
  }
}
