import { Module } from '@nestjs/common';
import { OpenWAModule } from '../../integrations/openwa/openwa.module';
import { GatewayModule } from '../gateway/gateway.module';
import { MessageJobController } from './message-job.controller';
import { MessageJobProcessorService } from './message-job-processor.service';
import { MessageJobRepository } from './message-job.repository';
import { MessageJobService } from './message-job.service';
import { MessageSendPolicyService } from './message-send-policy.service';
import { OutboundSessionLeaseRepository } from './outbound-session-lease.repository';
import { OutboundSessionLeaseService } from './outbound-session-lease.service';

@Module({
  imports: [GatewayModule, OpenWAModule],
  controllers: [MessageJobController],
  providers: [
    MessageJobRepository,
    MessageJobService,
    MessageSendPolicyService,
    MessageJobProcessorService,
    OutboundSessionLeaseRepository,
    OutboundSessionLeaseService,
  ],
  exports: [MessageJobRepository, MessageSendPolicyService, MessageJobProcessorService],
})
export class MessagesModule {}
