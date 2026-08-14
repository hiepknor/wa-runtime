import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenWAClient } from '../../src/integrations/openwa/openwa.client';
import {
  RUNTIME_OPENWA_WEBHOOK_EVENTS,
  WebhookRegistrationReconciliationTick,
} from '../../src/modules/webhooks/webhook-registration-reconciliation.tick';

const callbackUrl = 'https://runtime.example.test/api/v1/webhooks/openwa';
const secret = 'test-secret-at-least-thirty-two-characters';

const registration = (id: string, url = callbackUrl) => ({
  id,
  sessionId: 'upstream-session',
  url,
  events: ['message.received'],
  active: true,
  retryCount: 3,
});

const client = () => ({
  listWebhooks: vi.fn(),
  registerWebhook: vi.fn(),
  updateWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
});

describe('WebhookRegistrationReconciliationTick', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('does not call OpenWA while disabled', async () => {
    const openwa = client();
    await new WebhookRegistrationReconciliationTick(openwa as unknown as OpenWAClient, {
      enabled: false,
      callbackUrl: null,
      secret,
      allowedSessionIds: ['session-one'],
    }).run();

    expect(openwa.listWebhooks).not.toHaveBeenCalled();
  });

  it('creates the managed registration without changing callbacks owned by another URL', async () => {
    const openwa = client();
    openwa.listWebhooks.mockResolvedValue([registration('foreign', 'https://other.example.test/hook')]);
    openwa.registerWebhook.mockResolvedValue(registration('created'));

    await new WebhookRegistrationReconciliationTick(openwa as unknown as OpenWAClient, {
      enabled: true,
      callbackUrl,
      secret,
      allowedSessionIds: ['session-one'],
    }).run();

    expect(openwa.registerWebhook).toHaveBeenCalledWith({
      sessionId: 'session-one',
      url: callbackUrl,
      events: [...RUNTIME_OPENWA_WEBHOOK_EVENTS],
      secret,
      retryCount: 3,
    });
    expect(openwa.updateWebhook).not.toHaveBeenCalled();
    expect(openwa.deleteWebhook).not.toHaveBeenCalled();
  });

  it('updates the deterministic retained registration and deletes only same-URL duplicates', async () => {
    const openwa = client();
    openwa.listWebhooks.mockResolvedValue([
      registration('managed-z'),
      registration('foreign', 'https://other.example.test/hook'),
      registration('managed-a'),
    ]);
    openwa.updateWebhook.mockResolvedValue(registration('managed-a'));
    openwa.deleteWebhook.mockResolvedValue(undefined);

    await new WebhookRegistrationReconciliationTick(openwa as unknown as OpenWAClient, {
      enabled: true,
      callbackUrl: `${callbackUrl}/../openwa`,
      secret,
      allowedSessionIds: ['session-one'],
    }).run();

    expect(openwa.updateWebhook).toHaveBeenCalledWith({
      sessionId: 'session-one',
      webhookId: 'managed-a',
      url: callbackUrl,
      events: [...RUNTIME_OPENWA_WEBHOOK_EVENTS],
      secret,
      active: true,
      retryCount: 3,
    });
    expect(openwa.deleteWebhook).toHaveBeenCalledOnce();
    expect(openwa.deleteWebhook).toHaveBeenCalledWith('session-one', 'managed-z');
  });

  it('isolates a session failure, converges the next session and logs only aggregate data', async () => {
    const openwa = client();
    openwa.listWebhooks
      .mockRejectedValueOnce(new Error('failure containing sensitive-session-one'))
      .mockResolvedValueOnce([]);
    openwa.registerWebhook.mockResolvedValue(registration('created'));
    const warning = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const tick = new WebhookRegistrationReconciliationTick(openwa as unknown as OpenWAClient, {
      enabled: true,
      callbackUrl,
      secret,
      allowedSessionIds: ['sensitive-session-one', 'sensitive-session-two'],
    });

    await expect(tick.run()).rejects.toThrow('failed for 1 session(s)');
    expect(openwa.listWebhooks).toHaveBeenCalledTimes(2);
    expect(openwa.registerWebhook).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sensitive-session-two',
    }));
    expect(JSON.stringify(warning.mock.calls)).not.toContain('sensitive-session');
    expect(JSON.stringify(warning.mock.calls)).not.toContain(callbackUrl);
  });
});
