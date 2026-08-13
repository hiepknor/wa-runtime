import { Injectable, Logger } from '@nestjs/common';
import { OpenWAClient, OpenWAResponseValidationError } from '../../integrations/openwa/openwa.client';
import { ContactRepository } from './contact.repository';

@Injectable()
export class ContactSyncService {
  private readonly logger = new Logger(ContactSyncService.name);

  constructor(
    private readonly repository: ContactRepository,
    private readonly openwa: OpenWAClient,
  ) {}

  async reconcileObservedContacts(sessionId: string): Promise<void> {
    const generation = await this.repository.beginObservedSnapshot(sessionId);
    const startedAt = Date.now();
    let records = 0;
    let enriched = 0;
    let conflicts = 0;
    try {
      for await (const page of this.openwa.listContactPages(sessionId)) {
        const result = await this.repository.ingestObservedPage(sessionId, page);
        records += result.observed;
        enriched += result.enriched;
        conflicts += result.conflicts;
      }
      await this.repository.completeObservedSnapshot(sessionId, generation, records);
      this.logger.log({
        event: 'contacts.snapshot.completed', records, enriched, conflicts,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const code = error instanceof OpenWAResponseValidationError ? 'INVALID_RESPONSE' : 'UPSTREAM_ERROR';
      await this.repository.failObservedSnapshot(sessionId, generation, code).catch(() => undefined);
      this.logger.warn({ event: 'contacts.snapshot.failed', code, durationMs: Date.now() - startedAt });
      throw error;
    }
  }
}

