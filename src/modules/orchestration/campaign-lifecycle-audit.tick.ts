import { Injectable, Logger } from '@nestjs/common';
import { CampaignRunRepository } from '../campaigns/campaign-run.repository';

@Injectable()
export class CampaignLifecycleAuditTick {
  private readonly logger = new Logger(CampaignLifecycleAuditTick.name);

  constructor(private readonly runs: CampaignRunRepository) {}

  async run(): Promise<void> {
    const drift = await this.runs.auditLifecycle();
    const count = Object.values(drift).reduce((total, value) => total + value, 0);
    if (count > 0) {
      this.logger.warn({ event: 'campaign.lifecycle.drift_detected', count, ...drift });
    }
  }
}
