import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { WebhookController } from './webhook.controller';
import { WebhookRepository } from './webhook.repository';
import { RuntimeEventRepository } from './runtime-event.repository';

@Module({
  imports: [GatewayModule],
  controllers: [WebhookController],
  providers: [WebhookRepository, RuntimeEventRepository],
  exports: [WebhookRepository, RuntimeEventRepository],
})
export class WebhooksModule {}
