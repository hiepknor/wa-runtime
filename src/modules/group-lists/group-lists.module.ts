import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { GroupListController } from './group-list.controller';
import { GroupListRepository } from './group-list.repository';
import { GroupListService } from './group-list.service';

@Module({
  imports: [GatewayModule],
  controllers: [GroupListController],
  providers: [GroupListRepository, GroupListService],
  exports: [GroupListRepository],
})
export class GroupListsModule {}
