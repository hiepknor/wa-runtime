import { Module } from '@nestjs/common';
import { CampaignController } from './campaign.controller';
import { CampaignRepository } from './campaign.repository';
import { CampaignService } from './campaign.service';

@Module({
  controllers: [CampaignController],
  providers: [CampaignRepository, CampaignService],
  exports: [CampaignRepository, CampaignService],
})
export class CampaignsModule {}
