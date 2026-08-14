import { Module } from '@nestjs/common';
import { ContactRepository } from './contact.repository';
import { ContactSyncService } from './contact-sync.service';
import { OpenWAModule } from '../../integrations/openwa/openwa.module';
import { ContactMessageObserverService } from './contact-message-observer.service';
import { runtimeConfig } from '../../core/config/runtime-config';
import { ContactPeriodicSyncTick } from './contact-periodic-sync.tick';
import { OpenWAClient } from '../../integrations/openwa/openwa.client';
import { ContactMemberIdentityBackfillRepository } from './contact-member-identity-backfill.repository';
import { ContactMemberIdentityBackfillTick } from './contact-member-identity-backfill.tick';
import { DatabaseService } from '../../core/database/database.service';
import { ContactEvidenceWriter } from './contact-evidence.writer';

@Module({
  imports: [OpenWAModule],
  providers: [
    {
      provide: ContactEvidenceWriter,
      useFactory: () => new ContactEvidenceWriter(
        runtimeConfig().CONTACT_EVIDENCE_DUAL_WRITE_ENABLED,
      ),
    },
    {
      provide: ContactRepository,
      useFactory: (database: DatabaseService, evidenceWriter: ContactEvidenceWriter) => new ContactRepository(
        database,
        runtimeConfig().CONTACT_SNAPSHOT_STAGING_ENABLED,
        runtimeConfig().CONTACT_SNAPSHOT_RETENTION_DAYS,
        evidenceWriter,
      ),
      inject: [DatabaseService, ContactEvidenceWriter],
    },
    ContactMemberIdentityBackfillRepository,
    {
      provide: ContactSyncService,
      useFactory: (repository: ContactRepository, openwa: OpenWAClient) =>
        new ContactSyncService(repository, openwa, runtimeConfig().CONTACT_PERIODIC_SYNC_INTERVAL_MS),
      inject: [ContactRepository, OpenWAClient],
    },
    {
      provide: ContactPeriodicSyncTick,
      useFactory: (repository: ContactRepository, sync: ContactSyncService) => new ContactPeriodicSyncTick(
        repository,
        sync,
        {
          enabled: runtimeConfig().CONTACT_PERIODIC_SYNC_ENABLED,
          allowedSessionIds: runtimeConfig().OPENWA_ALLOWED_SESSION_IDS,
        },
      ),
      inject: [ContactRepository, ContactSyncService],
    },
    {
      provide: ContactMessageObserverService,
      useFactory: (repository: ContactRepository) => new ContactMessageObserverService(
        repository,
        runtimeConfig().CONTACT_MESSAGE_ENRICHMENT_ENABLED,
      ),
      inject: [ContactRepository],
    },
    {
      provide: ContactMemberIdentityBackfillTick,
      useFactory: (repository: ContactMemberIdentityBackfillRepository) =>
        new ContactMemberIdentityBackfillTick(repository, {
          enabled: runtimeConfig().CONTACT_MEMBER_IDENTITY_BACKFILL_ENABLED,
          batchSize: runtimeConfig().CONTACT_MEMBER_IDENTITY_BACKFILL_BATCH_SIZE,
          maxBatchesPerTick: runtimeConfig().CONTACT_MEMBER_IDENTITY_BACKFILL_MAX_BATCHES,
        }),
      inject: [ContactMemberIdentityBackfillRepository],
    },
  ],
  exports: [
    ContactRepository,
    ContactSyncService,
    ContactMessageObserverService,
    ContactPeriodicSyncTick,
    ContactMemberIdentityBackfillTick,
    ContactEvidenceWriter,
  ],
})
export class ContactsModule {}
