import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { GroupDetailDto, GroupListDto, GroupMemberListDto } from '../../contracts/groups/group.dto';
import { GroupIdentityQueryDto, GroupMemberQueryDto, GroupQueryDto } from '../../contracts/groups/group-query.dto';
import { GroupService } from './group.service';

@ApiTags('groups')
@ApiSecurity('runtime-key')
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
    description: 'Results are ordered deterministically by group name and group ID. Search and filters are applied before pagination and meta.total counts the filtered dataset.',
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
    summary: 'List synchronized group members without a contacts dependency',
    description: 'Results use deterministic super-admin, admin, normalized display name, and participant ID ordering.',
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
