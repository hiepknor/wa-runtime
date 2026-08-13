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

@Module({
  imports: [OpenWAModule],
  controllers: [SessionController, GroupController],
  providers: [GatewayRepository, GatewaySyncItemRepository, GatewaySyncService, GatewaySyncProcessorService, SessionService, GroupService, SessionStateCacheService, SessionScopeService],
  exports: [GatewayRepository, GatewaySyncItemRepository, GatewaySyncService, GatewaySyncProcessorService, SessionStateCacheService, SessionScopeService],
})
export class GatewayModule {}
