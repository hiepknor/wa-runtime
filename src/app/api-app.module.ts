import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { RuntimeApiKeyGuard } from '../core/auth/runtime-api-key.guard';
import { DatabaseModule } from '../core/database/database.module';
import { QueueModule } from '../core/queue/queue.module';
import { RequestContextMiddleware } from '../core/observability/request-context.middleware';
import { RuntimeHttpExceptionFilter } from '../core/http/runtime-http-exception.filter';
import { RuntimeConfigModule } from '../core/config/runtime-config.module';
import { OpenWAModule } from '../integrations/openwa/openwa.module';
import { CampaignsModule } from '../modules/campaigns/campaigns.module';
import { GatewayModule } from '../modules/gateway/gateway.module';
import { GroupListsModule } from '../modules/group-lists/group-lists.module';
import { HealthModule } from '../modules/health/health.module';
import { InboxModule } from '../modules/inbox/inbox.module';
import { MessagesModule } from '../modules/messages/messages.module';
import { WebhooksModule } from '../modules/webhooks/webhooks.module';

@Module({
  imports: [
    RuntimeConfigModule,
    DatabaseModule,
    QueueModule,
    OpenWAModule,
    GatewayModule,
    GroupListsModule,
    CampaignsModule,
    HealthModule,
    InboxModule,
    MessagesModule,
    WebhooksModule,
  ],
  providers: [
    RequestContextMiddleware,
    { provide: APP_GUARD, useClass: RuntimeApiKeyGuard },
    { provide: APP_FILTER, useClass: RuntimeHttpExceptionFilter },
  ],
})
export class ApiAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*splat}');
  }
}
