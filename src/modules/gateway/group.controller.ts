import { Controller, Get, HttpCode, Param, Post, Query, UseFilters } from '@nestjs/common';
import {
  ApiAcceptedResponse, ApiBadRequestResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation,
  ApiQuery, ApiSecurity, ApiTags,
} from '@nestjs/swagger';
import { RuntimeErrorDto } from '../../contracts/common/runtime-error.dto';
import { GroupDetailDto, GroupListDto, GroupMemberListDto } from '../../contracts/groups/group.dto';
import { GroupIdentityQueryDto, GroupMemberQueryDto, GroupQueryDto } from '../../contracts/groups/group-query.dto';
import { GroupService } from './group.service';
import { GroupHttpExceptionFilter } from './group-http-exception.filter';

@ApiTags('groups')
@ApiSecurity('runtime-key')
@ApiBadRequestResponse({ type: RuntimeErrorDto })
@ApiNotFoundResponse({ type: RuntimeErrorDto })
@UseFilters(GroupHttpExceptionFilter)
@Controller('groups')
export class GroupController {
  constructor(private readonly groups: GroupService) {}

  @Get()
  @ApiQuery({
    name: 'capabilityStatus',
    required: false,
    enum: ['ALLOWED', 'DENIED', 'UNKNOWN'],
    isArray: true,
    style: 'form',
    explode: false,
  })
  @ApiQuery({
    name: 'capabilityFreshness',
    required: false,
    enum: ['CURRENT', 'STALE'],
    isArray: true,
    style: 'form',
    explode: false,
  })
  @ApiOperation({
    summary: 'Search and filter synchronized groups from the Runtime read model',
    description: 'Results are ordered deterministically by group name and group ID. Search, capability, freshness, active-state, and inclusive participant-count filters are applied before pagination; meta.total counts the filtered dataset. Omitting isActive preserves active-only behavior.',
  })
  @ApiOkResponse({ type: GroupListDto })
  list(@Query() query: GroupQueryDto) {
    return this.groups.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read synchronized group metadata' })
  @ApiOkResponse({ type: GroupDetailDto })
  get(@Param('id') id: string, @Query() query: GroupIdentityQueryDto) {
    return this.groups.get(query.sessionId, id);
  }

  @Get(':id/members')
  @ApiOperation({
    summary: 'List materialized synchronized group members',
    description: 'Results use deterministic super-admin, admin, normalized display name, and participant ID ordering. resolvedPhoneNumber is nullable and phoneNumber remains a deprecated upstream compatibility value. meta.datasetRevision changes after every committed member dataset mutation.',
  })
  @ApiOkResponse({ type: GroupMemberListDto })
  members(
    @Param('id') id: string,
    @Query() query: GroupMemberQueryDto,
  ) {
    return this.groups.members(query.sessionId, id, query.limit, query.offset, query.query);
  }

  @Post(':id/refresh-capability')
  @HttpCode(202)
  @ApiOperation({ summary: 'Request an asynchronous capability refresh for one group' })
  @ApiAcceptedResponse({ schema: { example: { accepted: true } } })
  refreshCapability(@Param('id') id: string, @Query() query: GroupIdentityQueryDto) {
    return this.groups.refreshCapability(query.sessionId, id);
  }
}
