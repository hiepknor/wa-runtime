import { Module } from '@nestjs/common';
import { ContactRepository } from './contact.repository';
import { ContactSyncService } from './contact-sync.service';
import { OpenWAModule } from '../../integrations/openwa/openwa.module';

@Module({
  imports: [OpenWAModule],
  providers: [ContactRepository, ContactSyncService],
  exports: [ContactRepository, ContactSyncService],
})
export class ContactsModule {}
