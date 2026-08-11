import { Module } from '@nestjs/common';
import { OpenWAModule } from '../openwa/openwa.module';
import { MessagesModule } from '../messages/messages.module';
import { CampaignController } from './campaign.controller';
import { CampaignRunController } from './campaign-run.controller';
import { CampaignRepository } from './campaign.repository';
import { CampaignService } from './campaign.service';
import { CampaignPreflightService } from './campaign-preflight.service';
import { CampaignRunRepository } from './campaign-run.repository';
import { CampaignRunService } from './campaign-run.service';
import { SessionStateCacheService } from './session-state-cache.service';

@Module({
  imports: [OpenWAModule, MessagesModule],
  controllers: [CampaignController, CampaignRunController],
  providers: [CampaignRepository, CampaignService, CampaignPreflightService, CampaignRunRepository, CampaignRunService, SessionStateCacheService],
  exports: [CampaignRepository, CampaignService, CampaignRunRepository, CampaignRunService, SessionStateCacheService],
})
export class CampaignsModule {}
