import { Injectable, Logger } from '@nestjs/common';
import { OpenWAClient, OpenWAResponseValidationError } from '../../integrations/openwa/openwa.client';
import { ContactRepository } from './contact.repository';
import { ContactSnapshotConflictError } from './contact-snapshot.errors';

@Injectable()
export class ContactSyncService {
  private readonly logger = new Logger(ContactSyncService.name);
  constructor(
    private readonly repository: ContactRepository,
    private readonly openwa: OpenWAClient,
    private readonly periodicIntervalMs = 86_400_000,
  ) {}

  async reconcileObservedContacts(sessionId: string, force = true): Promise<boolean> {
    const claim = await this.repository.beginObservedSnapshot(sessionId, force);
    if (!claim) return false;
    const { generation, leaseToken } = claim;
    const startedAt = Date.now();
    let records = 0;
    let enriched = 0;
    let merged = 0;
    let conflicts = 0;
    try {
      for await (const page of this.openwa.listContactPages(sessionId)) {
        const result = await this.repository.ingestObservedPage(sessionId, generation, leaseToken, page);
        records += result.observed;
        enriched += result.enriched;
      }
      const identityResult = await this.repository.reconcileObservedIdentities(sessionId, generation, leaseToken);
      enriched += identityResult.enriched;
      merged += identityResult.merged;
      conflicts += identityResult.conflicts;
      await this.repository.completeObservedSnapshot(
        sessionId,
        generation,
        leaseToken,
        records,
        this.periodicIntervalMs,
      );
      const coverage = await this.repository.getCoverageMetrics(sessionId).catch(() => {
        this.logger.warn({ event: 'contacts.coverage.read_failed' });
        return {};
      });
      this.logger.log({
        event: 'contacts.snapshot.completed', records, enriched, merged, conflicts,
        durationMs: Date.now() - startedAt, coverage,
      });
      return true;
    } catch (error) {
      const code = error instanceof OpenWAResponseValidationError || error instanceof ContactSnapshotConflictError
        ? 'INVALID_RESPONSE'
        : 'UPSTREAM_ERROR';
      await this.repository.failObservedSnapshot(sessionId, generation, leaseToken, code).catch(() => undefined);
      this.logger.warn({ event: 'contacts.snapshot.failed', code, durationMs: Date.now() - startedAt });
      throw error;
    }
  }
}
