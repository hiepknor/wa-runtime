import { Injectable, NotFoundException } from '@nestjs/common';
import { GatewayRepository } from './gateway.repository';

@Injectable()
export class GroupService {
  constructor(private readonly repository: GatewayRepository) {}

  async list(sessionId: string, limit: number, offset: number) {
    const result = await this.repository.listGroups(sessionId, limit, offset);
    return { data: result.data, meta: { total: result.total, limit, offset } };
  }

  async get(sessionId: string, groupId: string) {
    const group = await this.repository.findGroup(sessionId, groupId);
    if (!group) throw new NotFoundException('Group not found');
    const members = await this.repository.listMembers(sessionId, groupId, 10_000, 0);
    return { ...group, members: members.data };
  }

  async members(sessionId: string, groupId: string, limit: number, offset: number) {
    if (!await this.repository.findGroup(sessionId, groupId)) throw new NotFoundException('Group not found');
    const result = await this.repository.listMembers(sessionId, groupId, limit, offset);
    return { data: result.data, meta: { total: result.total, limit, offset } };
  }

  async refreshCapability(sessionId: string, groupId: string) {
    if (!await this.repository.findGroup(sessionId, groupId)) throw new NotFoundException('Group not found');
    await this.repository.invalidateGroupCapability(sessionId, groupId, 'MANUAL_REFRESH');
    return { accepted: true };
  }
}
