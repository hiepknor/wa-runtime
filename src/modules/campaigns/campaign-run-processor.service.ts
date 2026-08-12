import { Injectable } from '@nestjs/common';
import { CampaignRunService } from './campaign-run.service';

@Injectable()
export class CampaignRunProcessorService {
  constructor(private readonly runs: CampaignRunService) {}

  process(runId: string): Promise<void> {
    return this.runs.prepare(runId);
  }
}
