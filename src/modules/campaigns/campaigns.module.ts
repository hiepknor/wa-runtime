import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { MessagesModule } from '../messages/messages.module';
import { CampaignController } from './campaign.controller';
import { CampaignRunController } from './campaign-run.controller';
import { CampaignRepository } from './campaign.repository';
import { CampaignService } from './campaign.service';
import { CampaignPreflightService } from './campaign-preflight.service';
import { CampaignRunRepository } from './campaign-run.repository';
import { CampaignRunService } from './campaign-run.service';

@Module({
  imports: [GatewayModule, MessagesModule],
  controllers: [CampaignController, CampaignRunController],
  providers: [CampaignRepository, CampaignService, CampaignPreflightService, CampaignRunRepository, CampaignRunService],
  exports: [CampaignRepository, CampaignService, CampaignRunRepository, CampaignRunService],
})
export class CampaignsModule {}
