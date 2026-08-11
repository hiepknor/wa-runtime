import { Module } from '@nestjs/common';
import { MessageJobController } from './message-job.controller';
import { MessageJobRepository } from './message-job.repository';
import { MessageJobService } from './message-job.service';

@Module({
  controllers: [MessageJobController],
  providers: [MessageJobRepository, MessageJobService],
  exports: [MessageJobRepository],
})
export class MessagesModule {}
