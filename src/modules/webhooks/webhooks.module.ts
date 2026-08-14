import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { WebhookController } from './webhook.controller';
import { WebhookRepository } from './webhook.repository';
import { RuntimeEventRepository } from './runtime-event.repository';
import { MessagesModule } from '../messages/messages.module';
import { WebhookProcessorService } from './webhook-processor.service';
import { ContactsModule } from '../contacts/contacts.module';
import { OpenWAModule } from '../../integrations/openwa/openwa.module';
import { OpenWAClient } from '../../integrations/openwa/openwa.client';
import { runtimeConfig } from '../../core/config/runtime-config';
import { WebhookRegistrationReconciliationTick } from './webhook-registration-reconciliation.tick';

@Module({
  imports: [GatewayModule, MessagesModule, ContactsModule, OpenWAModule],
  controllers: [WebhookController],
  providers: [
    WebhookRepository,
    RuntimeEventRepository,
    WebhookProcessorService,
    {
      provide: WebhookRegistrationReconciliationTick,
      useFactory: (openwa: OpenWAClient) => {
        const config = runtimeConfig();
        return new WebhookRegistrationReconciliationTick(openwa, {
          enabled: config.OPENWA_WEBHOOK_RECONCILIATION_ENABLED,
          callbackUrl: config.OPENWA_WEBHOOK_CALLBACK_URL ?? null,
          secret: config.OPENWA_WEBHOOK_SECRET,
          allowedSessionIds: config.OPENWA_ALLOWED_SESSION_IDS,
        });
      },
      inject: [OpenWAClient],
    },
  ],
  exports: [
    WebhookRepository,
    RuntimeEventRepository,
    WebhookProcessorService,
    WebhookRegistrationReconciliationTick,
  ],
})
export class WebhooksModule {}
