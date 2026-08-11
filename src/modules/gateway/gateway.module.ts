import { Module } from '@nestjs/common';
import { OpenWAModule } from '../../integrations/openwa/openwa.module';
import { GroupController } from './group.controller';
import { GatewayRepository } from './gateway.repository';
import { GatewaySyncService } from './gateway-sync.service';
import { GroupService } from './group.service';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';
import { SessionStateCacheService } from './session-state-cache.service';

@Module({
  imports: [OpenWAModule],
  controllers: [SessionController, GroupController],
  providers: [GatewayRepository, GatewaySyncService, SessionService, GroupService, SessionStateCacheService],
  exports: [GatewayRepository, GatewaySyncService, SessionStateCacheService],
})
export class GatewayModule {}
