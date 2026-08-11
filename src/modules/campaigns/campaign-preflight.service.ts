import { Injectable } from '@nestjs/common';
import { runtimeConfig } from '../../core/config/runtime-config';
import type { CampaignExecutionMode } from '../../contracts/campaigns/campaign-preflight.dto';
import type { CampaignTargetDto } from '../../contracts/campaigns/campaign-target.dto';
import { evaluateCampaignPreflight } from './campaign-preflight';
import { SessionStateCacheService } from '../gateway/session-state-cache.service';

@Injectable()
export class CampaignPreflightService {
  private readonly config = runtimeConfig();

  constructor(private readonly sessionStates: SessionStateCacheService) {}

  async evaluate(input: {
    executionMode: CampaignExecutionMode;
    sessionId: string;
    text: string;
    targets: CampaignTargetDto[];
  }) {
    const session = await this.sessionStates.get(input.sessionId);
    return evaluateCampaignPreflight({
      executionMode: input.executionMode,
      text: input.text,
      targets: input.targets,
      session,
      liveSendsEnabled: this.config.ALLOW_LIVE_SENDS,
    });
  }
}
