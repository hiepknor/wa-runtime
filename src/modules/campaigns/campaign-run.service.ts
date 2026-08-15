import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import type { CampaignExecutionMode } from '../../contracts/campaigns/campaign-preflight.dto';
import type { CreateCampaignRunDto } from '../../contracts/campaigns/campaign-run.dto';
import { CampaignPreflightService } from './campaign-preflight.service';
import { CampaignRunRepository } from './campaign-run.repository';
import { CampaignService } from './campaign.service';
import { CampaignError } from './campaign-error';

@Injectable()
export class CampaignRunService {
  constructor(
    private readonly repository: CampaignRunRepository,
    private readonly campaigns: CampaignService,
    private readonly preflights: CampaignPreflightService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async create(campaignId: string, rawIdempotencyKey: string | undefined, dto: CreateCampaignRunDto) {
    const idempotencyKey = rawIdempotencyKey?.trim();
    if (!idempotencyKey) {
      throw new CampaignError(HttpStatus.BAD_REQUEST, 'CAMPAIGN_RUN_IDEMPOTENCY_KEY_REQUIRED',
        'Idempotency-Key header is required');
    }
    if (idempotencyKey.length > 200) {
      throw new CampaignError(HttpStatus.BAD_REQUEST, 'CAMPAIGN_RUN_IDEMPOTENCY_KEY_INVALID',
        'Idempotency-Key must not exceed 200 characters');
    }
    await this.campaigns.get(campaignId);
    const result = await this.repository.create({
      campaignId,
      idempotencyKey,
      executionMode: dto.executionMode,
      expectedCampaignRevision: dto.expectedCampaignRevision,
      expectedTargetsRevision: dto.expectedTargetsRevision,
    });
    if (!result.campaignFound) {
      throw new CampaignError(HttpStatus.NOT_FOUND, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
    }
    if (result.idempotencyConflict) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_RUN_IDEMPOTENCY_CONFLICT',
        'Idempotency-Key was already used with a different executionMode');
    }
    if (result.campaignNotLaunchable) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_RUN_LAUNCH_CONFLICT',
        'Campaign is not launchable from its current lifecycle state');
    }
    if (result.revisionConflict) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_RUN_REVISION_CONFLICT',
        'Campaign content or targets changed after launch review', {
          currentCampaignRevision: result.currentCampaignRevision,
          currentTargetsRevision: result.currentTargetsRevision,
        });
    }
    if (result.scheduleExpired) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_RUN_SCHEDULE_EXPIRED',
        'The ONCE campaign schedule is already in the past');
    }
    if (!result.run) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_RUN_LAUNCH_CONFLICT',
        'Campaign run could not be created');
    }
    return result;
  }

  async prepare(runId: string): Promise<void> {
    const claim = await this.repository.claimPreparation(runId);
    if (!claim) return;
    try {
      const context = await this.repository.getPreflightContext(runId);
      if (!context || context.run.status !== 'PREPARING') return;
      const report = await this.preflights.evaluate({
        executionMode: context.run.executionMode,
        sessionId: context.run.sessionId,
        text: context.run.text,
        targets: context.targets,
        campaignRevision: context.campaignRevision,
        targetsRevision: context.targetsRevision,
      });
      await this.repository.applyPreflight(runId, claim.leaseToken, report, context.targets);
    } catch (error) {
      await this.repository.failPreparationAttempt(
        runId,
        claim.leaseToken,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async get(id: string) {
    const run = await this.repository.find(id);
    if (!run || !this.config.OPENWA_ALLOWED_SESSION_IDS.includes(run.sessionId)) {
      throw new CampaignError(HttpStatus.NOT_FOUND, 'CAMPAIGN_RUN_NOT_FOUND', 'Campaign run not found');
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

  async pause(id: string) {
    const current = await this.get(id);
    if (!['SCHEDULED', 'RUNNING'].includes(current.status)) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_RUN_STATE_CONFLICT',
        `Campaign run cannot be paused from ${current.status}`);
    }
    const run = await this.repository.pause(id);
    if (!run) throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_RUN_STATE_CONFLICT',
      'Campaign run state changed; reload and retry');
    return run;
  }

  async resume(id: string) {
    const current = await this.get(id);
    if (!['PAUSED', 'BLOCKED'].includes(current.status)) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_RUN_STATE_CONFLICT',
        `Campaign run cannot be resumed from ${current.status}`);
    }
    const context = await this.repository.getPreflightContext(id);
    if (!context) throw new CampaignError(HttpStatus.NOT_FOUND, 'CAMPAIGN_RUN_NOT_FOUND', 'Campaign run not found');
    const report = await this.preflights.evaluate({
      executionMode: context.run.executionMode,
      sessionId: context.run.sessionId,
      text: context.run.text,
      targets: context.targets,
      campaignRevision: context.campaignRevision,
      targetsRevision: context.targetsRevision,
    });
    if (report.status === 'BLOCK') {
      await this.repository.recordBlockedResume(id, report);
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_RUN_STATE_CONFLICT',
        'Campaign run is still blocked by preflight', { preflight: report });
    }
    const run = await this.repository.resume(id, report, context.targets);
    if (run === 'STALE_INPUT') {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_RUN_STATE_CONFLICT',
        'Group capability changed during resume preflight; retry with current state');
    }
    if (!run) throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_RUN_STATE_CONFLICT',
      'Campaign run state changed; reload and retry');
    return run;
  }

  async cancel(id: string) {
    const current = await this.get(id);
    if (!['PREPARING', 'BLOCKED', 'SCHEDULED', 'RUNNING', 'PAUSED'].includes(current.status)) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_RUN_STATE_CONFLICT',
        `Campaign run cannot be cancelled from ${current.status}`);
    }
    const run = await this.repository.cancel(id);
    if (!run) throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_RUN_STATE_CONFLICT',
      'Campaign run state changed; reload and retry');
    return run;
  }
}
