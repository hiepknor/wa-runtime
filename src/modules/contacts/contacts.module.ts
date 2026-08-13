import { Module } from '@nestjs/common';
import { ContactRepository } from './contact.repository';
import { ContactSyncService } from './contact-sync.service';
import { OpenWAModule } from '../../integrations/openwa/openwa.module';
import { ContactMessageObserverService } from './contact-message-observer.service';
import { runtimeConfig } from '../../core/config/runtime-config';
import { ContactPeriodicSyncTick } from './contact-periodic-sync.tick';
import { OpenWAClient } from '../../integrations/openwa/openwa.client';

@Module({
  imports: [OpenWAModule],
  providers: [
    ContactRepository,
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
  ],
  exports: [ContactRepository, ContactSyncService, ContactMessageObserverService, ContactPeriodicSyncTick],
})
export class ContactsModule {}
