import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenWAClient, OpenWAResponseValidationError } from '../../src/integrations/openwa/openwa.client';

vi.mock('../../src/core/config/runtime-config', () => ({
  runtimeConfig: () => ({
    OPENWA_BASE_URL: 'http://openwa.test',
    OPENWA_API_KEY: 'test-key',
    OPENWA_RELEASE_TAG: '0.16.0',
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it('normalizes missing summary subjects while keeping group details strict', async () => {
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
    await expect(new OpenWAClient().getGroup('session-1', 'group-1'))
      .rejects.toBeInstanceOf(OpenWAResponseValidationError);
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
});
