import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { WebhookController } from './webhook.controller';
import { WebhookRepository } from './webhook.repository';
import { RuntimeEventRepository } from './runtime-event.repository';
import { MessagesModule } from '../messages/messages.module';
import { WebhookProcessorService } from './webhook-processor.service';

@Module({
  imports: [GatewayModule, MessagesModule],
  controllers: [WebhookController],
  providers: [WebhookRepository, RuntimeEventRepository, WebhookProcessorService],
  exports: [WebhookRepository, RuntimeEventRepository, WebhookProcessorService],
})
export class WebhooksModule {}
