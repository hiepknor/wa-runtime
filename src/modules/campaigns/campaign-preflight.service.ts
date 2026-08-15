import { Inject, Injectable } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import type { CampaignExecutionMode } from '../../contracts/campaigns/campaign-preflight.dto';
import type { CampaignTargetDto } from '../../contracts/campaigns/campaign-target.dto';
import { evaluateCampaignPreflight } from './campaign-preflight';
import { GatewayRepository } from '../gateway/gateway.repository';

@Injectable()
export class CampaignPreflightService {
  constructor(
    private readonly gateway: GatewayRepository,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async evaluate(input: {
    executionMode: CampaignExecutionMode;
    sessionId: string;
    text: string;
    targets: CampaignTargetDto[];
    campaignRevision: number;
    targetsRevision: number;
  }) {
    const persistedSession = await this.gateway.findSession(input.sessionId);
    const session = persistedSession
      ? {
          status: persistedSession.status,
          engineLoaded: persistedSession.engineLoaded,
          restricted: persistedSession.restriction !== null,
        }
      : { status: 'missing', engineLoaded: false, restricted: true };
    return evaluateCampaignPreflight({
      executionMode: input.executionMode,
      text: input.text,
      targets: input.targets,
      session,
      liveSendsEnabled: this.config.ALLOW_LIVE_SENDS,
      campaignRevision: input.campaignRevision,
      targetsRevision: input.targetsRevision,
    });
  }
}
