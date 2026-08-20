import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OpenWAClient,
  OpenWAHttpError,
  OpenWAResponseValidationError,
} from '../../src/integrations/openwa/openwa.client';

vi.mock('../../src/core/config/runtime-config', () => ({
  runtimeConfig: () => ({
    OPENWA_BASE_URL: 'http://openwa.test',
    OPENWA_API_KEY: 'test-key',
    OPENWA_RELEASE_TAG: '0.22.0',
  }),
}));

const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
});

describe('OpenWAClient response validation', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('accepts only the reviewed OpenWA 0.22.0 release', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        status: 'ok', timestamp: '2026-08-20T00:00:00Z', version: '0.22.0',
      }))
      .mockResolvedValueOnce(jsonResponse({
        status: 'ok', timestamp: '2026-08-20T00:00:00Z', version: '0.22.1',
      }));
    vi.stubGlobal('fetch', fetchMock);
    const openwa = new OpenWAClient();

    await expect(openwa.assertCompatibleRelease()).resolves.toBeUndefined();
    await expect(openwa.assertCompatibleRelease()).rejects.toThrow(
      'OpenWA release mismatch: expected 0.22.0, received 0.22.1',
    );
    const firstRequest = fetchMock.mock.calls[0];
    const headers = new Headers((firstRequest?.[1] as RequestInit | undefined)?.headers);
    expect(headers.get('x-api-key')).toBe('test-key');
  });

  it('accepts a valid session and discards fields outside the integration contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      id: 'session-1', name: 'Session', status: 'ready', engineLoaded: true,
      restriction: null, createdAt: '2026-08-12T00:00:00Z', updatedAt: '2026-08-12T00:00:00Z',
      secretInternalField: 'must-not-cross-boundary',
    })));

    const result = await new OpenWAClient().getSession('session-1');

    expect(result).toMatchObject({ id: 'session-1', status: 'ready', engineLoaded: true });
    expect(result).not.toHaveProperty('secretInternalField');
  });

  it('rejects malformed group details and duplicate participant ids without exposing payload data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      id: 'group-1', name: 'Group', participants: [
        { id: 'member-1', number: 'secret-phone-1', isAdmin: false, isSuperAdmin: false },
        { id: 'member-1', number: 'secret-phone-2', isAdmin: false, isSuperAdmin: false },
      ],
    })));

    const failure = new OpenWAClient().getGroup('session-1', 'group-1');

    await expect(failure).rejects.toBeInstanceOf(OpenWAResponseValidationError);
    await expect(failure).rejects.not.toThrow(/secret-phone/);
  });

  it('normalizes missing subjects in both group summaries and details', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([
        { id: 'group-1', linkedParentJID: null },
        { id: 'group-2', name: '', linkedParentJID: null },
      ]))
      .mockResolvedValueOnce(jsonResponse({
        id: 'group-1', participants: [], linkedParentJID: null,
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new OpenWAClient().listGroups('session-1')).resolves.toEqual([
      { id: 'group-1', name: 'Group subject pending sync', linkedParentJID: null },
      { id: 'group-2', name: 'Group subject pending sync', linkedParentJID: null },
    ]);
    await expect(new OpenWAClient().getGroup('session-1', 'group-1')).resolves.toMatchObject({
      id: 'group-1', name: 'Group subject pending sync', participants: [],
    });
  });

  it('fails bounded pagination when a later page repeats group ids', async () => {
    const page = Array.from({ length: 1000 }, (_, index) => ({ id: `group-${index}`, name: `Group ${index}` }));
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(page)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new OpenWAClient().listGroups('session-1'))
      .rejects.toBeInstanceOf(OpenWAResponseValidationError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an oversized page before accumulating it', async () => {
    const page = Array.from({ length: 1001 }, (_, index) => ({ id: `group-${index}`, name: `Group ${index}` }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(page)));

    await expect(new OpenWAClient().listGroups('session-1'))
      .rejects.toBeInstanceOf(OpenWAResponseValidationError);
  });

  it('streams bounded contact pages and rejects duplicate identities across pages', async () => {
    const contact = (id: string) => ({ id, number: id.replace(/@c\.us$/, ''), isMyContact: true, isBlocked: false });
    const first = Array.from({ length: 1000 }, (_, index) => contact(`${index}@c.us`));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(first))
      .mockResolvedValueOnce(jsonResponse([contact('1000@c.us')]));
    vi.stubGlobal('fetch', fetchMock);

    const pages: unknown[][] = [];
    for await (const page of new OpenWAClient().listContactPages('session-1')) pages.push(page);

    expect(pages.map(page => page.length)).toEqual([1000, 1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(first))));
    const duplicate = async () => {
      for await (const _page of new OpenWAClient().listContactPages('session-1')) { /* consume */ }
    };
    await expect(duplicate()).rejects.toBeInstanceOf(OpenWAResponseValidationError);
  });

  it('retries rate-limited GET requests using gateway retry metadata', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'rate limited' }, 429))
      .mockResolvedValueOnce(jsonResponse({ message: 'rate limited' }, 429))
      .mockResolvedValueOnce(jsonResponse({
        id: 'session-1', name: 'Session', status: 'ready', engineLoaded: true,
        restriction: null, createdAt: '2026-08-12T00:00:00Z', updatedAt: '2026-08-12T00:00:00Z',
      }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const request = new OpenWAClient().getSession('session-1');
    await vi.advanceTimersByTimeAsync(249);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(request).resolves.toMatchObject({ id: 'session-1', status: 'ready' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('leaves group-detail server failures to the durable reconciliation retry owner', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'temporary engine failure' }, 500))
      .mockResolvedValueOnce(jsonResponse({
        id: 'group-1', name: 'Group', participants: [], linkedParentJID: null,
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new OpenWAClient().getGroup('session-1', 'group-1'))
      .rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves group-detail rate limits to the durable reconciliation retry owner', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'rate-overlimit' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '7' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const failure = await new OpenWAClient().getGroup('session-1', 'group-1').catch(error => error);
    expect(failure).toBeInstanceOf(OpenWAHttpError);
    expect(failure).toMatchObject({ status: 429, retryAfterMs: 7_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('validates and mutates webhook registrations through the pinned OpenWA contract', async () => {
    const webhook = {
      id: 'webhook-1', sessionId: 'session-1', url: 'https://runtime.test/api/v1/webhooks/openwa',
      events: ['message.received'], active: true, retryCount: 3,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([webhook]))
      .mockResolvedValueOnce(jsonResponse(webhook))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const openwa = new OpenWAClient();

    await expect(openwa.listWebhooks('session-1')).resolves.toEqual([webhook]);
    await expect(openwa.updateWebhook({
      sessionId: 'session-1', webhookId: 'webhook-1', url: webhook.url,
      events: webhook.events, secret: 'secret', active: true, retryCount: 3,
    })).resolves.toEqual(webhook);
    await expect(openwa.deleteWebhook('session-1', 'webhook-1')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(2, new URL(
      '/api/sessions/session-1/webhooks/webhook-1', 'http://openwa.test',
    ), expect.objectContaining({ method: 'PUT' }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, new URL(
      '/api/sessions/session-1/webhooks/webhook-1', 'http://openwa.test',
    ), expect.objectContaining({ method: 'DELETE' }));
  });
});
