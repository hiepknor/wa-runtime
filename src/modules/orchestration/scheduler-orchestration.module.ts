import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../core/database/database.module';
import { QueueModule } from '../../core/queue/queue.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { GatewayModule } from '../gateway/gateway.module';
import { MessagesModule } from '../messages/messages.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { CampaignDispatchTick } from './campaign-dispatch.tick';
import { CampaignLifecycleAuditTick } from './campaign-lifecycle-audit.tick';
import { DataRetentionTick } from './data-retention.tick';
import { GatewayDispatchTick } from './gateway-dispatch.tick';
import { MessageDispatchTick } from './message-dispatch.tick';
import { SchedulerRunnerService } from './scheduler-runner.service';
import { WebhookDispatchTick } from './webhook-dispatch.tick';
import { GatewayWorkListenerService } from './gateway-work-listener.service';
import { ContactsModule } from '../contacts/contacts.module';
import { SchedulerLeadershipService } from './scheduler-leadership.service';

@Module({
  imports: [DatabaseModule, QueueModule, MessagesModule, WebhooksModule, GatewayModule, CampaignsModule, ContactsModule],
  providers: [
    MessageDispatchTick,
    WebhookDispatchTick,
    GatewayDispatchTick,
    CampaignDispatchTick,
    CampaignLifecycleAuditTick,
    DataRetentionTick,
    SchedulerRunnerService,
    SchedulerLeadershipService,
    GatewayWorkListenerService,
  ],
  exports: [SchedulerRunnerService],
})
export class SchedulerOrchestrationModule {}
