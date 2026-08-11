import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RuntimeApiKeyGuard } from './auth/runtime-api-key.guard';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MessagesModule } from './messages/messages.module';
import { OpenWAModule } from './openwa/openwa.module';
import { QueueModule } from './queue/queue.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [DatabaseModule, QueueModule, OpenWAModule, HealthModule, MessagesModule, WebhooksModule],
  providers: [{ provide: APP_GUARD, useClass: RuntimeApiKeyGuard }],
})
export class AppModule {}
