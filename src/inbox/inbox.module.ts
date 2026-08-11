import { Module } from '@nestjs/common';
import { InboxController } from './inbox.controller';
import { InboxRepository } from './inbox.repository';

@Module({ controllers: [InboxController], providers: [InboxRepository] })
export class InboxModule {}
