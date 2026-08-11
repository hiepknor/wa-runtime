import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { GroupDetailDto, GroupListDto, GroupMemberListDto } from '../contracts/groups/group.dto';
import { GroupIdentityQueryDto, GroupQueryDto } from '../contracts/groups/group-query.dto';
import { GroupService } from './group.service';

@ApiTags('groups')
@ApiSecurity('runtime-key')
@Controller('groups')
export class GroupController {
  constructor(private readonly groups: GroupService) {}

  @Get()
  @ApiOperation({ summary: 'List active groups from the Runtime read model' })
  @ApiOkResponse({ type: GroupListDto })
  list(@Query() query: GroupQueryDto) {
    return this.groups.list(query.sessionId, query.limit, query.offset);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read a group and its synchronized members' })
  @ApiOkResponse({ type: GroupDetailDto })
  get(@Param('id') id: string, @Query() query: GroupIdentityQueryDto) {
    return this.groups.get(query.sessionId, id);
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'List synchronized group members without a contacts dependency' })
  @ApiOkResponse({ type: GroupMemberListDto })
  members(
    @Param('id') id: string,
    @Query() query: GroupQueryDto,
  ) {
    return this.groups.members(query.sessionId, id, query.limit ?? 50, query.offset ?? 0);
  }
}
