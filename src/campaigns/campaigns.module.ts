import { Module } from '@nestjs/common';
import { OpenWAModule } from '../openwa/openwa.module';
import { CampaignController } from './campaign.controller';
import { CampaignRepository } from './campaign.repository';
import { CampaignService } from './campaign.service';
import { SessionStateCacheService } from './session-state-cache.service';

@Module({
  imports: [OpenWAModule],
  controllers: [CampaignController],
  providers: [CampaignRepository, CampaignService, SessionStateCacheService],
  exports: [CampaignRepository, CampaignService, SessionStateCacheService],
})
export class CampaignsModule {}
