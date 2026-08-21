import { Module } from '@nestjs/common';
import { ContactRepository } from './contact.repository';
import { ContactSyncService } from './contact-sync.service';
import { OpenWAModule } from '../../integrations/openwa/openwa.module';
import { ContactMessageObserverService } from './contact-message-observer.service';
import type { RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
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
import { ContactMessageObservationIntentRepository } from './contact-message-observation-intent.repository';
import { ContactMessageObservationTick } from './contact-message-observation.tick';

@Module({
  imports: [OpenWAModule],
  providers: [
    {
      provide: ContactEvidenceWriter,
      useFactory: (config: RuntimeConfig) => new ContactEvidenceWriter(
        config.CONTACT_EVIDENCE_DUAL_WRITE_ENABLED,
        config.CONTACT_PROJECTION_SHADOW_ENABLED,
      ),
      inject: [RUNTIME_CONFIG],
    },
    {
      provide: ContactRepository,
      useFactory: (database: DatabaseService, evidenceWriter: ContactEvidenceWriter, config: RuntimeConfig) => new ContactRepository(
        database,
        config.CONTACT_SNAPSHOT_STAGING_ENABLED,
        config.CONTACT_SNAPSHOT_RETENTION_DAYS,
        evidenceWriter,
        config.CONTACT_LEGACY_MEMBER_FANOUT_ENABLED,
      ),
      inject: [DatabaseService, ContactEvidenceWriter, RUNTIME_CONFIG],
    },
    ContactMemberIdentityBackfillRepository,
    ContactMessageObservationIntentRepository,
    {
      provide: ContactResolutionRepository,
      useFactory: (database: DatabaseService, config: RuntimeConfig) => new ContactResolutionRepository(
        database,
        config.CONTACT_PROJECTION_SHADOW_ENABLED,
        config.OPENWA_ALLOWED_SESSION_IDS,
      ),
      inject: [DatabaseService, RUNTIME_CONFIG],
    },
    {
      provide: ContactResolutionTick,
      useFactory: (repository: ContactResolutionRepository, config: RuntimeConfig) => new ContactResolutionTick(
        repository,
        {
          enabled: config.CONTACT_RESOLUTION_SHADOW_ENABLED,
          maxRunsPerTick: config.CONTACT_RESOLUTION_MAX_RUNS_PER_TICK,
        },
      ),
      inject: [ContactResolutionRepository, RUNTIME_CONFIG],
    },
    {
      provide: ContactProjectionRepository,
      useFactory: (database: DatabaseService, config: RuntimeConfig) => new ContactProjectionRepository(
        database,
        !config.CONTACT_LEGACY_MEMBER_FANOUT_ENABLED,
        config.OPENWA_ALLOWED_SESSION_IDS,
      ),
      inject: [DatabaseService, RUNTIME_CONFIG],
    },
    {
      provide: ContactProjectionTick,
      useFactory: (repository: ContactProjectionRepository, config: RuntimeConfig) => new ContactProjectionTick(
        repository,
        {
          enabled: config.CONTACT_PROJECTION_SHADOW_ENABLED,
          batchSize: config.CONTACT_PROJECTION_BATCH_SIZE,
          maxJobsPerTick: config.CONTACT_PROJECTION_MAX_JOBS_PER_TICK,
          maxBatchesPerJob: config.CONTACT_PROJECTION_MAX_BATCHES_PER_JOB,
          bootstrapBatchSize: config.CONTACT_PROJECTION_BOOTSTRAP_BATCH_SIZE,
          evidenceBackfillEnabled: config.CONTACT_EVIDENCE_BACKFILL_ENABLED,
          evidenceBackfillBatchSize: config.CONTACT_EVIDENCE_BACKFILL_BATCH_SIZE,
        },
      ),
      inject: [ContactProjectionRepository, RUNTIME_CONFIG],
    },
    {
      provide: ContactSyncService,
      useFactory: (repository: ContactRepository, openwa: OpenWAClient, config: RuntimeConfig) =>
        new ContactSyncService(repository, openwa, config.CONTACT_PERIODIC_SYNC_INTERVAL_MS),
      inject: [ContactRepository, OpenWAClient, RUNTIME_CONFIG],
    },
    {
      provide: ContactPeriodicSyncTick,
      useFactory: (repository: ContactRepository, sync: ContactSyncService, config: RuntimeConfig) => new ContactPeriodicSyncTick(
        repository,
        sync,
        {
          enabled: config.CONTACT_PERIODIC_SYNC_ENABLED,
          allowedSessionIds: config.OPENWA_ALLOWED_SESSION_IDS,
        },
      ),
      inject: [ContactRepository, ContactSyncService, RUNTIME_CONFIG],
    },
    {
      provide: ContactMessageObserverService,
      useFactory: (
        repository: ContactRepository,
        intents: ContactMessageObservationIntentRepository,
        config: RuntimeConfig,
      ) => new ContactMessageObserverService(
        repository,
        intents,
        config.CONTACT_MESSAGE_ENRICHMENT_ENABLED,
      ),
      inject: [ContactRepository, ContactMessageObservationIntentRepository, RUNTIME_CONFIG],
    },
    {
      provide: ContactMessageObservationTick,
      useFactory: (
        intents: ContactMessageObservationIntentRepository,
        observer: ContactMessageObserverService,
        config: RuntimeConfig,
      ) => new ContactMessageObservationTick(intents, observer, {
        enabled: config.CONTACT_MESSAGE_ENRICHMENT_ENABLED,
        maxPerTick: 100,
      }),
      inject: [ContactMessageObservationIntentRepository, ContactMessageObserverService, RUNTIME_CONFIG],
    },
    {
      provide: ContactMemberIdentityBackfillTick,
      useFactory: (repository: ContactMemberIdentityBackfillRepository, config: RuntimeConfig) =>
        new ContactMemberIdentityBackfillTick(repository, {
          enabled: config.CONTACT_MEMBER_IDENTITY_BACKFILL_ENABLED,
          batchSize: config.CONTACT_MEMBER_IDENTITY_BACKFILL_BATCH_SIZE,
          maxBatchesPerTick: config.CONTACT_MEMBER_IDENTITY_BACKFILL_MAX_BATCHES,
        }),
      inject: [ContactMemberIdentityBackfillRepository, RUNTIME_CONFIG],
    },
  ],
  exports: [
    ContactRepository,
    ContactSyncService,
    ContactMessageObserverService,
    ContactMessageObservationIntentRepository,
    ContactMessageObservationTick,
    ContactPeriodicSyncTick,
    ContactMemberIdentityBackfillTick,
    ContactEvidenceWriter,
    ContactResolutionTick,
    ContactProjectionTick,
  ],
})
export class ContactsModule {}
