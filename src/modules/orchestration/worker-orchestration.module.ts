import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../core/database/database.module';
import { QueueModule } from '../../core/queue/queue.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { GatewayModule } from '../gateway/gateway.module';
import { MessagesModule } from '../messages/messages.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { WorkerRunnerService } from './worker-runner.service';

@Module({
  imports: [DatabaseModule, QueueModule, MessagesModule, WebhooksModule, GatewayModule, CampaignsModule],
  providers: [WorkerRunnerService],
  exports: [WorkerRunnerService],
})
export class WorkerOrchestrationModule {}
