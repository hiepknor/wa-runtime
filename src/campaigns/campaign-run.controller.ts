import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CampaignDeliveryListDto } from '../contracts/campaigns/campaign-delivery.dto';
import { CampaignRunDto } from '../contracts/campaigns/campaign-run.dto';
import { PaginationQueryDto } from '../contracts/common/pagination.dto';
import { CampaignRunService } from './campaign-run.service';

@ApiTags('campaign-runs')
@ApiSecurity('runtime-key')
@Controller('campaign-runs')
export class CampaignRunController {
  constructor(private readonly runs: CampaignRunService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Read a durable campaign run' })
  @ApiOkResponse({ type: CampaignRunDto })
  get(@Param('id', ParseUUIDPipe) id: string) { return this.runs.get(id); }

  @Get(':id/deliveries')
  @ApiOperation({ summary: 'List per-group deliveries for a campaign run' })
  @ApiOkResponse({ type: CampaignDeliveryListDto })
  deliveries(@Param('id', ParseUUIDPipe) id: string, @Query() query: PaginationQueryDto) {
    return this.runs.deliveries(id, query.limit, query.offset);
  }
}
