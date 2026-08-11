import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookRepository } from './webhook.repository';
import { RuntimeEventRepository } from './runtime-event.repository';

@Module({
  controllers: [WebhookController],
  providers: [WebhookRepository, RuntimeEventRepository],
  exports: [WebhookRepository, RuntimeEventRepository],
})
export class WebhooksModule {}
