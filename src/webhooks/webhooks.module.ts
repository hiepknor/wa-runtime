import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookRepository } from './webhook.repository';

@Module({ controllers: [WebhookController], providers: [WebhookRepository], exports: [WebhookRepository] })
export class WebhooksModule {}
