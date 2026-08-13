import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { WebhookController } from './webhook.controller';
import { WebhookRepository } from './webhook.repository';
import { RuntimeEventRepository } from './runtime-event.repository';
import { MessagesModule } from '../messages/messages.module';
import { WebhookProcessorService } from './webhook-processor.service';
import { ContactsModule } from '../contacts/contacts.module';

@Module({
  imports: [GatewayModule, MessagesModule, ContactsModule],
  controllers: [WebhookController],
  providers: [WebhookRepository, RuntimeEventRepository, WebhookProcessorService],
  exports: [WebhookRepository, RuntimeEventRepository, WebhookProcessorService],
})
export class WebhooksModule {}
