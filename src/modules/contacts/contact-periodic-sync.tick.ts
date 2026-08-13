import { Injectable, Logger } from '@nestjs/common';
import { ContactRepository } from './contact.repository';
import { ContactSyncService } from './contact-sync.service';

export interface ContactPeriodicSyncOptions {
  enabled: boolean;
  allowedSessionIds: string[];
}

@Injectable()
export class ContactPeriodicSyncTick {
  private readonly logger = new Logger(ContactPeriodicSyncTick.name);
  constructor(
    private readonly repository: ContactRepository,
    private readonly sync: ContactSyncService,
    private readonly options: ContactPeriodicSyncOptions,
  ) {}

  async run(): Promise<void> {
    if (!this.options.enabled) return;
    const sessionIds = await this.repository.listPeriodicSessionIds(
      this.options.allowedSessionIds,
      10,
    );
    let completed = 0;
    let failed = 0;
    for (const sessionId of sessionIds) {
      try {
        if (await this.sync.reconcileObservedContacts(sessionId, false)) completed += 1;
      } catch {
        failed += 1;
      }
    }
    if (sessionIds.length > 0) {
      this.logger.log({ event: 'contacts.periodic.completed', claimed: sessionIds.length, completed, failed });
    }
  }
}
