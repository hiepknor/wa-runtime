import { Module } from '@nestjs/common';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { WebhookController } from './webhook.controller';
import { WebhookRepository } from './webhook.repository';
import { RuntimeEventRepository } from './runtime-event.repository';

@Module({
  imports: [CampaignsModule],
  controllers: [WebhookController],
  providers: [WebhookRepository, RuntimeEventRepository],
  exports: [WebhookRepository, RuntimeEventRepository],
})
export class WebhooksModule {}
