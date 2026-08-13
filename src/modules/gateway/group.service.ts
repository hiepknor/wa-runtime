import { Injectable, NotFoundException } from '@nestjs/common';
import type { GroupQueryDto } from '../../contracts/groups/group-query.dto';
import { GatewayRepository } from './gateway.repository';
import { SessionScopeService } from './session-scope.service';

@Injectable()
export class GroupService {
  constructor(
    private readonly repository: GatewayRepository,
    private readonly sessions: SessionScopeService,
  ) {}

  async list(query: GroupQueryDto) {
    this.sessions.assertVisible(query.sessionId);
    const result = await this.repository.listGroups(query);
    return { data: result.data, meta: { total: result.total, limit: query.limit, offset: query.offset } };
  }

  async get(sessionId: string, groupId: string) {
    this.sessions.assertVisible(sessionId);
    const group = await this.repository.findGroup(sessionId, groupId);
    if (!group) throw new NotFoundException('Group not found');
    return group;
  }

  async members(sessionId: string, groupId: string, limit: number, offset: number, query?: string) {
    this.sessions.assertVisible(sessionId);
    if (!await this.repository.findGroup(sessionId, groupId)) throw new NotFoundException('Group not found');
    const result = await this.repository.listMembers(sessionId, groupId, limit, offset, query);
    return { data: result.data, meta: { total: result.total, limit, offset } };
  }

  async refreshCapability(sessionId: string, groupId: string) {
    this.sessions.assertVisible(sessionId);
    if (!await this.repository.findGroup(sessionId, groupId)) throw new NotFoundException('Group not found');
    await this.repository.invalidateGroupCapability(sessionId, groupId, 'MANUAL_REFRESH');
    return { accepted: true };
  }
}
