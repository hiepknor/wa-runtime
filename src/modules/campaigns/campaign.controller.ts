import {
  Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res,
  UseFilters,
} from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiHeader, ApiNotFoundResponse,
  ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiResponse, ApiSecurity, ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { PaginationQueryDto } from '../../contracts/common/pagination.dto';
import { RuntimeErrorDto } from '../../contracts/common/runtime-error.dto';
import { CampaignDto, CampaignListDto, CampaignStatus } from '../../contracts/campaigns/campaign.dto';
import { CampaignQueryDto } from '../../contracts/campaigns/campaign-query.dto';
import { CampaignPreflightDto, CampaignPreflightRequestDto } from '../../contracts/campaigns/campaign-preflight.dto';
import {
  ApplyGroupListTargetsDto,
  CampaignTargetListDto,
  ReplaceCampaignTargetsDto,
} from '../../contracts/campaigns/campaign-target.dto';
import { CampaignScheduleType, CreateCampaignDto } from '../../contracts/campaigns/create-campaign.dto';
import { DeleteCampaignQueryDto } from '../../contracts/campaigns/delete-campaign.dto';
import { UpdateCampaignDto } from '../../contracts/campaigns/update-campaign.dto';
import { CampaignRunDto, CampaignRunListDto, CreateCampaignRunDto } from '../../contracts/campaigns/campaign-run.dto';
import { CampaignRunService } from './campaign-run.service';
import { CampaignService } from './campaign.service';
import { CampaignHttpExceptionFilter } from './campaign-http-exception.filter';

@ApiTags('campaigns')
@ApiSecurity('runtime-key')
@ApiBadRequestResponse({ type: RuntimeErrorDto })
@ApiNotFoundResponse({ type: RuntimeErrorDto })
@ApiConflictResponse({ type: RuntimeErrorDto })
@ApiUnprocessableEntityResponse({ type: RuntimeErrorDto })
@UseFilters(CampaignHttpExceptionFilter)
@Controller('campaigns')
export class CampaignController {
  constructor(
    private readonly campaigns: CampaignService,
    private readonly runs: CampaignRunService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a text campaign draft' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiCreatedResponse({ type: CampaignDto })
  @ApiResponse({ status: 200, type: CampaignDto, description: 'Idempotent replay' })
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateCampaignDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.campaigns.create(dto, idempotencyKey);
    response.status(result.created ? 201 : 200);
    return result.campaign;
  }

  @Get()
  @ApiQuery({
    name: 'status', required: false, enum: CampaignStatus, isArray: true, style: 'form', explode: false,
  })
  @ApiQuery({
    name: 'scheduleType', required: false, enum: CampaignScheduleType, isArray: true,
    style: 'form', explode: false,
  })
  @ApiOperation({
    summary: 'Search and filter campaigns for allowlisted sessions',
    description: 'Search and filters are applied before pagination. Results use updatedAt DESC and campaign ID ASC ordering; meta.total counts the filtered dataset.',
  })
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

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a quiescent campaign from the active workspace',
    description: 'Creates a durable tombstone without deleting immutable run, delivery, or message-job audit data.',
  })
  @ApiNoContentResponse()
  async delete(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DeleteCampaignQueryDto,
  ): Promise<void> {
    await this.campaigns.delete(id, query);
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
    return this.campaigns.replaceTargets(id, dto.groupIds, dto.expectedTargetsRevision);
  }

  @Post(':id/targets/apply-group-list')
  @HttpCode(200)
  @ApiOperation({ summary: 'Atomically replace DRAFT campaign targets from one saved group-list revision' })
  @ApiOkResponse({ type: CampaignTargetListDto })
  applyGroupListTargets(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyGroupListTargetsDto,
  ) {
    return this.campaigns.applyGroupListTargets(id, dto);
  }

  @Post(':id/preflight')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Evaluate a campaign without creating a run' })
  @ApiOkResponse({ type: CampaignPreflightDto })
  preflight(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CampaignPreflightRequestDto,
  ) {
    return this.campaigns.preflight(id, dto);
  }

  @Post(':id/runs')
  @ApiOperation({ summary: 'Create an idempotent durable campaign run' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: CampaignRunDto })
  async createRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateCampaignRunDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.runs.create(id, idempotencyKey, dto);
    response.status(result.created ? 201 : 200);
    return result.run;
  }

  @Get(':id/runs')
  @ApiOperation({ summary: 'List runs of a campaign' })
  @ApiOkResponse({ type: CampaignRunListDto })
  listRuns(@Param('id', ParseUUIDPipe) id: string, @Query() query: PaginationQueryDto) {
    return this.runs.list(id, query.limit, query.offset);
  }
}
