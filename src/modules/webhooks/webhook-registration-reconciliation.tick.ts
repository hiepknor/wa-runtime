import { Injectable, Logger } from '@nestjs/common';
import { OpenWAClient } from '../../integrations/openwa/openwa.client';

export const RUNTIME_OPENWA_WEBHOOK_EVENTS = [
  'message.received',
  'message.sent',
  'message.ack',
  'message.failed',
  'session.status',
  'session.restriction',
  'group.join',
  'group.leave',
  'group.update',
] as const;

export interface WebhookRegistrationReconciliationOptions {
  enabled: boolean;
  callbackUrl: string | null;
  secret: string;
  allowedSessionIds: string[];
}

interface ReconciliationCounts {
  created: number;
  updated: number;
  deleted: number;
}

@Injectable()
export class WebhookRegistrationReconciliationTick {
  private readonly logger = new Logger(WebhookRegistrationReconciliationTick.name);

  constructor(
    private readonly openwa: OpenWAClient,
    private readonly options: WebhookRegistrationReconciliationOptions,
  ) {}

  async run(): Promise<void> {
    if (!this.options.enabled) return;
    if (!this.options.callbackUrl) {
      throw new Error('Webhook reconciliation is enabled without a callback URL');
    }

    const totals: ReconciliationCounts = { created: 0, updated: 0, deleted: 0 };
    let failed = 0;
    for (const sessionId of this.options.allowedSessionIds) {
      try {
        const counts = await this.reconcileSession(sessionId, this.options.callbackUrl);
        totals.created += counts.created;
        totals.updated += counts.updated;
        totals.deleted += counts.deleted;
      } catch {
        failed += 1;
      }
    }

    const details = {
      event: 'openwa.webhook_registration.reconciled',
      sessions: this.options.allowedSessionIds.length,
      failed,
      ...totals,
    };
    if (failed > 0) {
      this.logger.warn(details);
      throw new Error(`OpenWA webhook registration reconciliation failed for ${failed} session(s)`);
    }
    this.logger.log(details);
  }

  private async reconcileSession(sessionId: string, callbackUrl: string): Promise<ReconciliationCounts> {
    const normalizedCallbackUrl = normalizeUrl(callbackUrl);
    const registrations = await this.openwa.listWebhooks(sessionId);
    const managed = registrations
      .filter(registration => normalizeUrl(registration.url) === normalizedCallbackUrl)
      .sort((left, right) => left.id.localeCompare(right.id));
    const events = [...RUNTIME_OPENWA_WEBHOOK_EVENTS];

    if (managed.length === 0) {
      await this.openwa.registerWebhook({
        sessionId,
        url: normalizedCallbackUrl,
        events,
        secret: this.options.secret,
        retryCount: 3,
      });
      return { created: 1, updated: 0, deleted: 0 };
    }

    const retained = managed[0]!;
    await this.openwa.updateWebhook({
      sessionId,
      webhookId: retained.id,
      url: normalizedCallbackUrl,
      events,
      secret: this.options.secret,
      active: true,
      retryCount: 3,
    });
    for (const duplicate of managed.slice(1)) {
      await this.openwa.deleteWebhook(sessionId, duplicate.id);
    }
    return { created: 0, updated: 1, deleted: managed.length - 1 };
  }
}

const normalizeUrl = (value: string): string => new URL(value).toString();
