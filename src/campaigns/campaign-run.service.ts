import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { runtimeConfig } from '../config/runtime-config';
import type { CampaignExecutionMode } from '../contracts/campaigns/campaign-preflight.dto';
import { CampaignPreflightService } from './campaign-preflight.service';
import { CampaignRunRepository } from './campaign-run.repository';
import { CampaignService } from './campaign.service';

@Injectable()
export class CampaignRunService {
  private readonly config = runtimeConfig();

  constructor(
    private readonly repository: CampaignRunRepository,
    private readonly campaigns: CampaignService,
    private readonly preflights: CampaignPreflightService,
  ) {}

  async create(campaignId: string, idempotencyKey: string, executionMode: CampaignExecutionMode) {
    if (idempotencyKey.length > 200) throw new BadRequestException('Idempotency-Key must not exceed 200 characters');
    await this.campaigns.get(campaignId);
    const result = await this.repository.create({ campaignId, idempotencyKey, executionMode });
    if (!result.run || !result.campaignFound) throw new NotFoundException('Campaign not found');
    if (result.idempotencyConflict) {
      throw new ConflictException('Idempotency-Key was already used with a different executionMode');
    }
    return result;
  }

  async prepare(runId: string): Promise<void> {
    const context = await this.repository.getPreflightContext(runId);
    if (!context || context.run.status !== 'PREPARING') return;
    const report = await this.preflights.evaluate({
      executionMode: context.run.executionMode,
      sessionId: context.run.sessionId,
      text: context.run.text,
      targets: context.targets,
    });
    await this.repository.applyPreflight(runId, report);
  }

  markPreparationFailed(runId: string) {
    return this.repository.markPreparationFailed(runId);
  }

  async get(id: string) {
    const run = await this.repository.find(id);
    if (!run || !this.config.OPENWA_ALLOWED_SESSION_IDS.includes(run.sessionId)) {
      throw new NotFoundException('Campaign run not found');
    }
    return run;
  }

  async list(campaignId: string, limit: number, offset: number) {
    await this.campaigns.get(campaignId);
    const result = await this.repository.listByCampaign(campaignId, limit, offset);
    return { data: result.data, meta: { total: result.total, limit, offset } };
  }

  async deliveries(runId: string, limit: number, offset: number) {
    await this.get(runId);
    const result = await this.repository.listDeliveries(runId, limit, offset);
    return { data: result.data, meta: { total: result.total, limit, offset } };
  }
}
