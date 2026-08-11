import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CampaignDto, CampaignListDto } from '../contracts/campaigns/campaign.dto';
import { CampaignQueryDto } from '../contracts/campaigns/campaign-query.dto';
import { CampaignTargetListDto, ReplaceCampaignTargetsDto } from '../contracts/campaigns/campaign-target.dto';
import { CreateCampaignDto } from '../contracts/campaigns/create-campaign.dto';
import { UpdateCampaignDto } from '../contracts/campaigns/update-campaign.dto';
import { CampaignService } from './campaign.service';

@ApiTags('campaigns')
@ApiSecurity('runtime-key')
@Controller('campaigns')
export class CampaignController {
  constructor(private readonly campaigns: CampaignService) {}

  @Post()
  @ApiOperation({ summary: 'Create a text campaign draft' })
  @ApiCreatedResponse({ type: CampaignDto })
  create(@Body() dto: CreateCampaignDto) { return this.campaigns.create(dto); }

  @Get()
  @ApiOperation({ summary: 'List campaigns for allowlisted sessions' })
  @ApiOkResponse({ type: CampaignListDto })
  list(@Query() query: CampaignQueryDto) { return this.campaigns.list(query); }

  @Get(':id')
  @ApiOperation({ summary: 'Read a campaign' })
  @ApiOkResponse({ type: CampaignDto })
  get(@Param('id', ParseUUIDPipe) id: string) { return this.campaigns.get(id); }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an editable campaign draft' })
  @ApiOkResponse({ type: CampaignDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCampaignDto) {
    return this.campaigns.update(id, dto);
  }

  @Get(':id/targets')
  @ApiOperation({ summary: 'List selected group targets with current capability' })
  @ApiOkResponse({ type: CampaignTargetListDto })
  listTargets(@Param('id', ParseUUIDPipe) id: string) { return this.campaigns.listTargets(id); }

  @Put(':id/targets')
  @ApiOperation({ summary: 'Atomically replace all group targets of a campaign draft' })
  @ApiOkResponse({ type: CampaignTargetListDto })
  replaceTargets(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceCampaignTargetsDto,
  ) {
    return this.campaigns.replaceTargets(id, dto.groupIds);
  }
}
