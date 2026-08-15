import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { MessagesModule } from '../messages/messages.module';
import { GroupListsModule } from '../group-lists/group-lists.module';
import { CampaignController } from './campaign.controller';
import { CampaignRunController } from './campaign-run.controller';
import { CampaignRepository } from './campaign.repository';
import { CampaignService } from './campaign.service';
import { CampaignPreflightService } from './campaign-preflight.service';
import { CampaignRunRepository } from './campaign-run.repository';
import { CampaignRunService } from './campaign-run.service';
import { CampaignRunProcessorService } from './campaign-run-processor.service';

@Module({
  imports: [GatewayModule, GroupListsModule, MessagesModule],
  controllers: [CampaignController, CampaignRunController],
  providers: [CampaignRepository, CampaignService, CampaignPreflightService, CampaignRunRepository, CampaignRunService, CampaignRunProcessorService],
  exports: [CampaignRepository, CampaignService, CampaignRunRepository, CampaignRunService, CampaignRunProcessorService],
})
export class CampaignsModule {}
