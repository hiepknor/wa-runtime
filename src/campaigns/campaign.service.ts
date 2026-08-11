import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { runtimeConfig } from '../config/runtime-config';
import type { CampaignQueryDto } from '../contracts/campaigns/campaign-query.dto';
import type { CreateCampaignDto } from '../contracts/campaigns/create-campaign.dto';
import { CampaignScheduleType } from '../contracts/campaigns/create-campaign.dto';
import type { UpdateCampaignDto } from '../contracts/campaigns/update-campaign.dto';
import { CampaignRepository } from './campaign.repository';

@Injectable()
export class CampaignService {
  private readonly config = runtimeConfig();

  constructor(private readonly repository: CampaignRepository) {}

  async create(dto: CreateCampaignDto) {
    this.assertAllowedSession(dto.sessionId);
    if (!await this.repository.sessionExists(dto.sessionId)) throw new BadRequestException('Session is not synchronized');
    const schedule = this.resolveSchedule(dto.scheduleType, dto.scheduledAt);
    return this.repository.create({
      sessionId: dto.sessionId,
      name: this.nonBlank(dto.name, 'name'),
      text: this.nonBlank(dto.text, 'text'),
      ...schedule,
    });
  }

  async list(query: CampaignQueryDto) {
    if (query.sessionId) this.assertAllowedSession(query.sessionId);
    const result = await this.repository.list({
      allowedSessionIds: this.config.OPENWA_ALLOWED_SESSION_IDS,
      sessionId: query.sessionId,
      limit: query.limit,
      offset: query.offset,
    });
    return { data: result.data, meta: { total: result.total, limit: query.limit, offset: query.offset } };
  }

  async get(id: string) {
    const campaign = await this.repository.find(id);
    if (!campaign || !this.config.OPENWA_ALLOWED_SESSION_IDS.includes(campaign.sessionId)) {
      throw new NotFoundException('Campaign not found');
    }
    return campaign;
  }

  async update(id: string, dto: UpdateCampaignDto) {
    const current = await this.get(id);
    if (current.status !== 'DRAFT') throw new BadRequestException('Only DRAFT campaigns can be edited');
    const scheduleType = dto.scheduleType ?? current.scheduleType;
    const scheduledAt = dto.scheduledAt === undefined
      ? current.scheduledAt?.toISOString()
      : dto.scheduledAt ?? undefined;
    const schedule = this.resolveSchedule(scheduleType, scheduledAt);
    const updated = await this.repository.update(id, {
      name: dto.name === undefined ? current.name : this.nonBlank(dto.name, 'name'),
      text: dto.text === undefined ? current.text : this.nonBlank(dto.text, 'text'),
      ...schedule,
    });
    if (!updated) throw new BadRequestException('Campaign is no longer editable');
    return updated;
  }

  async listTargets(id: string) {
    await this.get(id);
    return { data: await this.repository.listTargets(id) };
  }

  async replaceTargets(id: string, groupIds: string[]) {
    const campaign = await this.get(id);
    if (campaign.status !== 'DRAFT') throw new BadRequestException('Only DRAFT campaign targets can be edited');
    const result = await this.repository.replaceTargets(id, groupIds);
    if (!result.campaignFound) throw new NotFoundException('Campaign not found');
    if (result.invalidGroupIds.length) {
      throw new BadRequestException({ message: 'Some groups are inactive or belong to another session', groupIds: result.invalidGroupIds });
    }
    return { data: result.targets };
  }

  private assertAllowedSession(sessionId: string): void {
    if (!this.config.OPENWA_ALLOWED_SESSION_IDS.includes(sessionId)) {
      throw new ForbiddenException('Session is not in OPENWA_ALLOWED_SESSION_IDS');
    }
  }

  private nonBlank(value: string, field: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new BadRequestException(`${field} must not be blank`);
    return trimmed;
  }

  private resolveSchedule(scheduleType: CampaignScheduleType, value?: string): {
    scheduleType: CampaignScheduleType;
    scheduledAt: Date | null;
  } {
    if (scheduleType === CampaignScheduleType.IMMEDIATE) {
      return { scheduleType, scheduledAt: null };
    }
    if (!value) throw new BadRequestException('scheduledAt is required for ONCE campaigns');
    const scheduledAt = new Date(value);
    if (scheduledAt <= new Date()) throw new BadRequestException('scheduledAt must be in the future');
    return { scheduleType, scheduledAt };
  }
}
