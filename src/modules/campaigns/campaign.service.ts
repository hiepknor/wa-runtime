import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException, HttpStatus, Injectable } from '@nestjs/common';
import { isISO8601, isUUID } from 'class-validator';
import { runtimeConfig } from '../../core/config/runtime-config';
import type { CampaignQueryDto } from '../../contracts/campaigns/campaign-query.dto';
import type { CampaignPreflightRequestDto } from '../../contracts/campaigns/campaign-preflight.dto';
import type { CreateCampaignDto } from '../../contracts/campaigns/create-campaign.dto';
import { CampaignScheduleType } from '../../contracts/campaigns/create-campaign.dto';
import type { UpdateCampaignDto } from '../../contracts/campaigns/update-campaign.dto';
import { CampaignRepository } from './campaign.repository';
import { CampaignPreflightService } from './campaign-preflight.service';
import { CampaignError } from './campaign-error';

@Injectable()
export class CampaignService {
  private readonly config = runtimeConfig();

  constructor(
    private readonly repository: CampaignRepository,
    private readonly preflights: CampaignPreflightService,
  ) {}

  async create(dto: CreateCampaignDto, rawIdempotencyKey: string | undefined) {
    this.assertAllowedSession(dto.sessionId);
    const idempotencyKey = rawIdempotencyKey?.trim();
    if (!idempotencyKey) {
      throw new CampaignError(HttpStatus.BAD_REQUEST, 'CAMPAIGN_IDEMPOTENCY_KEY_REQUIRED',
        'Idempotency-Key header is required');
    }
    if (!isUUID(idempotencyKey)) {
      throw new CampaignError(HttpStatus.BAD_REQUEST, 'CAMPAIGN_IDEMPOTENCY_KEY_INVALID',
        'Idempotency-Key must be a UUID');
    }
    if (!await this.repository.sessionExists(dto.sessionId)) {
      throw new CampaignError(HttpStatus.UNPROCESSABLE_ENTITY, 'CAMPAIGN_SESSION_NOT_FOUND',
        'Session is not synchronized');
    }
    const schedule = this.resolveSchedule(dto.scheduleType, dto.scheduledAt);
    const input = {
      sessionId: dto.sessionId,
      name: this.nonBlank(dto.name, 'name'),
      text: this.nonBlank(dto.text, 'text'),
      ...schedule,
    };
    const requestHash = createHash('sha256').update(JSON.stringify({
      ...input,
      scheduledAt: input.scheduledAt?.toISOString() ?? null,
    })).digest('hex');
    const result = await this.repository.create({ ...input, idempotencyKey, requestHash });
    if (result.requestHash !== requestHash) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_IDEMPOTENCY_CONFLICT',
        'Idempotency-Key was already used with a different campaign payload');
    }
    return { campaign: result.campaign, created: result.created };
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
      throw new CampaignError(HttpStatus.NOT_FOUND, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
    }
    return campaign;
  }

  async update(id: string, dto: UpdateCampaignDto) {
    const current = await this.get(id);
    if (current.status !== 'DRAFT') {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_NOT_EDITABLE',
        'Only DRAFT campaigns can be edited');
    }
    const schedulingTouched = dto.scheduleType !== undefined || dto.scheduledAt !== undefined;
    const schedule = schedulingTouched
      ? this.resolveSchedule(
          dto.scheduleType ?? current.scheduleType,
          dto.scheduledAt === undefined ? current.scheduledAt?.toISOString() : dto.scheduledAt,
        )
      : { scheduleType: current.scheduleType, scheduledAt: current.scheduledAt };
    const updated = await this.repository.update(id, {
      name: dto.name === undefined ? current.name : this.nonBlank(dto.name, 'name'),
      text: dto.text === undefined ? current.text : this.nonBlank(dto.text, 'text'),
      ...schedule,
    });
    if (!updated) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_NOT_EDITABLE',
        'Campaign is no longer editable');
    }
    return updated;
  }

  async listTargets(id: string) {
    await this.get(id);
    return { data: await this.repository.listTargets(id) };
  }

  async replaceTargets(id: string, groupIds: string[]) {
    const campaign = await this.get(id);
    if (campaign.status !== 'DRAFT') {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_NOT_EDITABLE',
        'Only DRAFT campaign targets can be edited');
    }
    if (groupIds.length > 1000) {
      throw new CampaignError(HttpStatus.UNPROCESSABLE_ENTITY, 'CAMPAIGN_TARGET_LIMIT_EXCEEDED',
        'A campaign can contain at most 1000 unique group targets', { maximum: 1000 });
    }
    if (new Set(groupIds).size !== groupIds.length) {
      throw new CampaignError(HttpStatus.UNPROCESSABLE_ENTITY, 'CAMPAIGN_TARGET_DUPLICATE',
        'Duplicate group target IDs are not allowed');
    }
    const result = await this.repository.replaceTargets(id, groupIds);
    if (!result.campaignFound) {
      throw new CampaignError(HttpStatus.NOT_FOUND, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
    }
    if (!result.campaignEditable) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_NOT_EDITABLE',
        'Campaign is no longer editable');
    }
    if (result.mismatchedGroupIds.length) {
      throw new CampaignError(HttpStatus.UNPROCESSABLE_ENTITY, 'CAMPAIGN_TARGET_SESSION_MISMATCH',
        'One or more groups do not belong to the campaign session',
        { invalidTargetCount: result.mismatchedGroupIds.length });
    }
    if (result.missingGroupIds.length) {
      throw new CampaignError(HttpStatus.UNPROCESSABLE_ENTITY, 'CAMPAIGN_TARGET_NOT_FOUND',
        'One or more groups are not present in the durable group read model',
        { invalidTargetCount: result.missingGroupIds.length });
    }
    return { data: result.targets };
  }

  async preflight(id: string, dto: CampaignPreflightRequestDto) {
    const snapshot = await this.repository.getPreflightSnapshot(id);
    if (!snapshot || !this.config.OPENWA_ALLOWED_SESSION_IDS.includes(snapshot.campaign.sessionId)) {
      throw new CampaignError(HttpStatus.NOT_FOUND, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
    }
    const { campaign, targets } = snapshot;
    return this.preflights.evaluate({
      executionMode: dto.executionMode,
      sessionId: campaign.sessionId,
      text: campaign.text,
      targets,
      campaignRevision: campaign.revision,
      targetsRevision: campaign.targetsRevision,
    });
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

  private resolveSchedule(scheduleType: CampaignScheduleType, value?: string | null): {
    scheduleType: CampaignScheduleType;
    scheduledAt: Date | null;
  } {
    if (scheduleType === CampaignScheduleType.IMMEDIATE) {
      return { scheduleType, scheduledAt: null };
    }
    if (!value) {
      throw new CampaignError(HttpStatus.UNPROCESSABLE_ENTITY, 'CAMPAIGN_SCHEDULE_REQUIRED',
        'scheduledAt is required for ONCE campaigns');
    }
    const hasExplicitTimeAndZone = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value);
    if (!hasExplicitTimeAndZone || !isISO8601(value, { strict: true, strictSeparator: true })) {
      throw new CampaignError(HttpStatus.UNPROCESSABLE_ENTITY, 'CAMPAIGN_SCHEDULE_INVALID',
        'scheduledAt must be a valid ISO-8601 date-time');
    }
    const scheduledAt = new Date(value);
    if (scheduledAt <= new Date()) {
      throw new CampaignError(HttpStatus.UNPROCESSABLE_ENTITY, 'CAMPAIGN_SCHEDULE_IN_PAST',
        'scheduledAt must be in the future');
    }
    return { scheduleType, scheduledAt };
  }
}
