import { Module } from '@nestjs/common';
import { InboxController } from './inbox.controller';
import { InboxRepository } from './inbox.repository';
import { GatewayModule } from '../gateway/gateway.module';
import { InboxService } from './inbox.service';

@Module({ imports: [GatewayModule], controllers: [InboxController], providers: [InboxRepository, InboxService] })
export class InboxModule {}
