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
import { ContactResolutionRepository } from './contact-resolution.repository';
import { ContactResolutionTick } from './contact-resolution.tick';
import { ContactProjectionRepository } from './contact-projection.repository';
import { ContactProjectionTick } from './contact-projection.tick';

@Module({
  imports: [OpenWAModule],
  providers: [
    {
      provide: ContactEvidenceWriter,
      useFactory: () => new ContactEvidenceWriter(
        runtimeConfig().CONTACT_EVIDENCE_DUAL_WRITE_ENABLED,
        runtimeConfig().CONTACT_PROJECTION_SHADOW_ENABLED,
      ),
    },
    {
      provide: ContactRepository,
      useFactory: (database: DatabaseService, evidenceWriter: ContactEvidenceWriter) => new ContactRepository(
        database,
        runtimeConfig().CONTACT_SNAPSHOT_STAGING_ENABLED,
        runtimeConfig().CONTACT_SNAPSHOT_RETENTION_DAYS,
        evidenceWriter,
        runtimeConfig().CONTACT_LEGACY_MEMBER_FANOUT_ENABLED,
      ),
      inject: [DatabaseService, ContactEvidenceWriter],
    },
    ContactMemberIdentityBackfillRepository,
    {
      provide: ContactResolutionRepository,
      useFactory: (database: DatabaseService) => new ContactResolutionRepository(
        database,
        runtimeConfig().CONTACT_PROJECTION_SHADOW_ENABLED,
      ),
      inject: [DatabaseService],
    },
    {
      provide: ContactResolutionTick,
      useFactory: (repository: ContactResolutionRepository) => new ContactResolutionTick(
        repository,
        {
          enabled: runtimeConfig().CONTACT_RESOLUTION_SHADOW_ENABLED,
          maxRunsPerTick: runtimeConfig().CONTACT_RESOLUTION_MAX_RUNS_PER_TICK,
        },
      ),
      inject: [ContactResolutionRepository],
    },
    {
      provide: ContactProjectionRepository,
      useFactory: (database: DatabaseService) => new ContactProjectionRepository(
        database,
        !runtimeConfig().CONTACT_LEGACY_MEMBER_FANOUT_ENABLED,
      ),
      inject: [DatabaseService],
    },
    {
      provide: ContactProjectionTick,
      useFactory: (repository: ContactProjectionRepository) => new ContactProjectionTick(
        repository,
        {
          enabled: runtimeConfig().CONTACT_PROJECTION_SHADOW_ENABLED,
          batchSize: runtimeConfig().CONTACT_PROJECTION_BATCH_SIZE,
          maxJobsPerTick: runtimeConfig().CONTACT_PROJECTION_MAX_JOBS_PER_TICK,
          maxBatchesPerJob: runtimeConfig().CONTACT_PROJECTION_MAX_BATCHES_PER_JOB,
          bootstrapBatchSize: runtimeConfig().CONTACT_PROJECTION_BOOTSTRAP_BATCH_SIZE,
        },
      ),
      inject: [ContactProjectionRepository],
    },
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
    ContactResolutionTick,
    ContactProjectionTick,
  ],
})
export class ContactsModule {}
