import { Module } from '@nestjs/common';
import { OpenWAModule } from '../../integrations/openwa/openwa.module';
import { GroupController } from './group.controller';
import { GatewayRepository } from './gateway.repository';
import { GatewaySyncService } from './gateway-sync.service';
import { GroupService } from './group.service';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';
import { SessionStateCacheService } from './session-state-cache.service';
import { SessionScopeService } from './session-scope.service';
import { GatewaySyncProcessorService } from './gateway-sync-processor.service';
import { GatewaySyncItemRepository } from './gateway-sync-item.repository';
import { GatewayGroupIntentRepository } from './gateway-group-intent.repository';
import { GatewaySyncRateLimitRepository } from './gateway-sync-rate-limit.repository';
import { ContactsModule } from '../contacts/contacts.module';
import { runtimeConfig } from '../../core/config/runtime-config';
import { DatabaseService } from '../../core/database/database.service';
import { ContactRepository } from '../contacts/contact.repository';

@Module({
  imports: [OpenWAModule, ContactsModule],
  controllers: [SessionController, GroupController],
  providers: [
    {
      provide: GatewayRepository,
      useFactory: (database: DatabaseService, contacts: ContactRepository) => new GatewayRepository(
        database,
        contacts,
        runtimeConfig().CONTACT_PROJECTION_READ_ENABLED,
      ),
      inject: [DatabaseService, ContactRepository],
    },
    GatewaySyncRateLimitRepository,
    GatewaySyncItemRepository,
    GatewayGroupIntentRepository,
    GatewaySyncService,
    GatewaySyncProcessorService,
    SessionService,
    GroupService,
    SessionStateCacheService,
    SessionScopeService,
  ],
  exports: [GatewayRepository, GatewaySyncRateLimitRepository, GatewaySyncItemRepository, GatewayGroupIntentRepository, GatewaySyncService, GatewaySyncProcessorService, SessionStateCacheService, SessionScopeService],
})
export class GatewayModule {}
