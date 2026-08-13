import { Module } from '@nestjs/common';
import { ContactRepository } from './contact.repository';
import { ContactSyncService } from './contact-sync.service';
import { OpenWAModule } from '../../integrations/openwa/openwa.module';
import { ContactMessageObserverService } from './contact-message-observer.service';
import { runtimeConfig } from '../../core/config/runtime-config';

@Module({
  imports: [OpenWAModule],
  providers: [
    ContactRepository,
    ContactSyncService,
    {
      provide: ContactMessageObserverService,
      useFactory: (repository: ContactRepository) => new ContactMessageObserverService(
        repository,
        runtimeConfig().CONTACT_MESSAGE_ENRICHMENT_ENABLED,
      ),
      inject: [ContactRepository],
    },
  ],
  exports: [ContactRepository, ContactSyncService, ContactMessageObserverService],
})
export class ContactsModule {}
