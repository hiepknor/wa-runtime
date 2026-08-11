import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { runtimeConfig } from '../config/runtime-config';
import { MESSAGE_SEND_QUEUE, WEBHOOK_QUEUE } from './queue.constants';

@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly connection = new IORedis(runtimeConfig().REDIS_URL, { maxRetriesPerRequest: null });
  readonly messageSend = new Queue(MESSAGE_SEND_QUEUE, { connection: this.connection });
  readonly webhookIngress = new Queue(WEBHOOK_QUEUE, { connection: this.connection });

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.messageSend.close(), this.webhookIngress.close()]);
    this.connection.disconnect();
  }
}
