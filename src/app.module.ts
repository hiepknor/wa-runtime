import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RuntimeApiKeyGuard } from './core/auth/runtime-api-key.guard';
import { DatabaseModule } from './core/database/database.module';
import { QueueModule } from './core/queue/queue.module';
import { OpenWAModule } from './integrations/openwa/openwa.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { GatewayModule } from './modules/gateway/gateway.module';
import { HealthModule } from './modules/health/health.module';
import { InboxModule } from './modules/inbox/inbox.module';
import { MessagesModule } from './modules/messages/messages.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

@Module({
  imports: [
    DatabaseModule,
    QueueModule,
    OpenWAModule,
    GatewayModule,
    CampaignsModule,
    HealthModule,
    InboxModule,
    MessagesModule,
    WebhooksModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: RuntimeApiKeyGuard }],
})
export class AppModule {}
