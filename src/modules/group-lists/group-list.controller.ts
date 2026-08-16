import {
  Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query,
  Res, UseFilters,
} from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiConflictResponse, ApiCreatedResponse, ApiHeader, ApiNoContentResponse,
  ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiResponse, ApiSecurity, ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RuntimeErrorDto } from '../../contracts/common/runtime-error.dto';
import { CreateGroupListDto } from '../../contracts/group-lists/create-group-list.dto';
import {
  GroupListMembershipDto,
  SavedGroupListDto,
  SavedGroupListPageDto,
} from '../../contracts/group-lists/group-list.dto';
import { GroupListArchiveQueryDto, GroupListQueryDto } from '../../contracts/group-lists/group-list-query.dto';
import { ReplaceGroupListGroupsDto } from '../../contracts/group-lists/replace-group-list-groups.dto';
import { UpdateGroupListDto } from '../../contracts/group-lists/update-group-list.dto';
import { GroupListHttpExceptionFilter } from './group-list-http-exception.filter';
import { GroupListService } from './group-list.service';

@ApiTags('group-lists')
@ApiSecurity('runtime-key')
@ApiBadRequestResponse({ type: RuntimeErrorDto })
@ApiNotFoundResponse({ type: RuntimeErrorDto })
@ApiConflictResponse({ type: RuntimeErrorDto })
@ApiUnprocessableEntityResponse({ type: RuntimeErrorDto })
@UseFilters(GroupListHttpExceptionFilter)
@Controller('group-lists')
export class GroupListController {
  constructor(private readonly groupLists: GroupListService) {}

  @Get()
  @ApiOperation({
    summary: 'Search active saved group lists in one allowlisted session',
    description: 'The trimmed literal search is applied before pagination. Results use updatedAt DESC and list ID ASC ordering; meta.total counts the filtered active dataset.',
  })
  @ApiOkResponse({ type: SavedGroupListPageDto })
  list(@Query() query: GroupListQueryDto) {
    return this.groupLists.list(query);
  }

  @Post()
  @ApiOperation({ summary: 'Create an idempotent saved group list with optional initial membership' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiCreatedResponse({ type: SavedGroupListDto })
  @ApiResponse({ status: 200, type: SavedGroupListDto, description: 'Idempotent replay' })
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateGroupListDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.groupLists.create(dto, idempotencyKey);
    response.status(result.created ? 201 : 200);
    return result.list;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read active saved group-list metadata' })
  @ApiOkResponse({ type: SavedGroupListDto })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.groupLists.get(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update active saved group-list metadata' })
  @ApiOkResponse({ type: SavedGroupListDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGroupListDto) {
    return this.groupLists.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Idempotently archive a saved group list without changing campaign targets',
    description: 'A repeated DELETE succeeds after the list has reached the archived state.',
  })
  @ApiNoContentResponse()
  async archive(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: GroupListArchiveQueryDto,
  ): Promise<void> {
    await this.groupLists.archive(id, query.expectedRevision);
  }

  @Get(':id/groups')
  @ApiOperation({
    summary: 'Read the complete bounded saved group-list membership',
    description: 'Returns at most 1,000 groups in deterministic normalized group-name and group-ID order.',
  })
  @ApiOkResponse({ type: GroupListMembershipDto })
  membership(@Param('id', ParseUUIDPipe) id: string) {
    return this.groupLists.membership(id);
  }

  @Put(':id/groups')
  @ApiOperation({ summary: 'Atomically replace the complete membership of an active saved group list' })
  @ApiOkResponse({ type: GroupListMembershipDto })
  replaceGroups(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceGroupListGroupsDto,
  ) {
    return this.groupLists.replaceGroups(
      id,
      dto.groupIds,
      dto.expectedRevision,
      dto.expectedMembershipRevision,
    );
  }
}
