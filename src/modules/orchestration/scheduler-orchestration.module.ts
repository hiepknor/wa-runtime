import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../core/database/database.module';
import { QueueModule } from '../../core/queue/queue.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { GatewayModule } from '../gateway/gateway.module';
import { MessagesModule } from '../messages/messages.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { CampaignDispatchTick } from './campaign-dispatch.tick';
import { DataRetentionTick } from './data-retention.tick';
import { GatewayDispatchTick } from './gateway-dispatch.tick';
import { MessageDispatchTick } from './message-dispatch.tick';
import { SchedulerRunnerService } from './scheduler-runner.service';
import { WebhookDispatchTick } from './webhook-dispatch.tick';

@Module({
  imports: [DatabaseModule, QueueModule, MessagesModule, WebhooksModule, GatewayModule, CampaignsModule],
  providers: [
    MessageDispatchTick,
    WebhookDispatchTick,
    GatewayDispatchTick,
    CampaignDispatchTick,
    DataRetentionTick,
    SchedulerRunnerService,
  ],
  exports: [SchedulerRunnerService],
})
export class SchedulerOrchestrationModule {}
