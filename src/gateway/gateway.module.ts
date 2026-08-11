import { Module } from '@nestjs/common';
import { OpenWAModule } from '../openwa/openwa.module';
import { GroupController } from './group.controller';
import { GatewayRepository } from './gateway.repository';
import { GatewaySyncService } from './gateway-sync.service';
import { GroupService } from './group.service';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';

@Module({
  imports: [OpenWAModule],
  controllers: [SessionController, GroupController],
  providers: [GatewayRepository, GatewaySyncService, SessionService, GroupService],
  exports: [GatewayRepository, GatewaySyncService],
})
export class GatewayModule {}
