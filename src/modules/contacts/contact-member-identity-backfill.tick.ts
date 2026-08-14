import { Injectable, Logger } from '@nestjs/common';
import { ContactMemberIdentityBackfillRepository } from './contact-member-identity-backfill.repository';

export interface ContactMemberIdentityBackfillOptions {
  enabled: boolean;
  batchSize: number;
  maxBatchesPerTick: number;
}

@Injectable()
export class ContactMemberIdentityBackfillTick {
  private readonly logger = new Logger(ContactMemberIdentityBackfillTick.name);

  constructor(
    private readonly repository: ContactMemberIdentityBackfillRepository,
    private readonly options: ContactMemberIdentityBackfillOptions,
  ) {}

  async run(): Promise<void> {
    if (!this.options.enabled) return;
    const leaseToken = await this.repository.claim();
    if (!leaseToken) return;
    let updated = 0;
    try {
      for (let batch = 0; batch < this.options.maxBatchesPerTick; batch += 1) {
        const result = await this.repository.processBatch(leaseToken, this.options.batchSize);
        if (result.lostOwnership) return;
        updated += result.updated;
        if (result.completed) {
          this.logger.log({ event: 'contacts.member_identity_backfill.completed', updated });
          return;
        }
      }
      if (!await this.repository.release(leaseToken)) return;
      this.logger.log({ event: 'contacts.member_identity_backfill.progressed', updated });
    } catch (error) {
      await this.repository.fail(leaseToken, 'BACKFILL_ERROR').catch(() => undefined);
      this.logger.warn({ event: 'contacts.member_identity_backfill.failed' });
      throw error;
    }
  }
}
