import { Injectable, Logger } from '@nestjs/common';
import { ContactProjectionRepository } from './contact-projection.repository';

export interface ContactProjectionOptions {
  enabled: boolean;
  batchSize: number;
  maxJobsPerTick: number;
  maxBatchesPerJob: number;
  bootstrapBatchSize: number;
  evidenceBackfillEnabled: boolean;
  evidenceBackfillBatchSize: number;
}

@Injectable()
export class ContactProjectionTick {
  private readonly logger = new Logger(ContactProjectionTick.name);

  constructor(
    private readonly repository: ContactProjectionRepository,
    private readonly options: ContactProjectionOptions,
  ) {}

  async run(): Promise<void> {
    if (!this.options.enabled) return;
    if (this.options.evidenceBackfillEnabled) {
      await this.repository.backfillEvidence(this.options.evidenceBackfillBatchSize);
    }
    await this.repository.enqueueBootstrap(this.options.bootstrapBatchSize);
    await this.repository.coalesceResolvedAliases(this.options.bootstrapBatchSize);
    await this.repository.catchUpMissingEvidence(this.options.bootstrapBatchSize);
    await this.repository.catchUpUnprojected(this.options.bootstrapBatchSize);
    let updated = 0;
    let completed = 0;
    for (let job = 0; job < this.options.maxJobsPerTick; job += 1) {
      const claim = await this.repository.claim();
      if (!claim) break;
      try {
        let finished = false;
        for (let batch = 0; batch < this.options.maxBatchesPerJob; batch += 1) {
          const result = await this.repository.projectBatch(claim, this.options.batchSize);
          updated += result.updated;
          if (result.completed) {
            completed += 1;
            finished = true;
            break;
          }
        }
        if (!finished) await this.repository.release(claim);
      } catch (error) {
        await this.repository.fail(claim).catch(() => undefined);
        this.logger.warn({ event: 'contacts.projection.failed' });
        throw error;
      }
    }
    if (updated > 0 || completed > 0) {
      const queue = await this.repository.getQueueMetrics();
      this.logger.log({ event: 'contacts.projection.completed', updated, completed, ...queue });
    }
  }
}
