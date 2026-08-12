import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

const ALLOWED_SESSION_ID = '00000000-0000-4000-8000-000000000001';

vi.mock('../../src/core/config/runtime-config', () => ({
  runtimeConfig: () => ({ OPENWA_ALLOWED_SESSION_IDS: [ALLOWED_SESSION_ID] }),
}));

import { SessionScopeService } from '../../src/modules/gateway/session-scope.service';

describe('SessionScopeService', () => {
  const scope = new SessionScopeService();

  it('allows configured sessions', () => {
    expect(scope.isAllowed(ALLOWED_SESSION_ID)).toBe(true);
    expect(() => scope.assertAllowed(ALLOWED_SESSION_ID)).not.toThrow();
    expect(() => scope.assertVisible(ALLOWED_SESSION_ID)).not.toThrow();
  });

  it('distinguishes forbidden writes from hidden reads', () => {
    const disallowed = '00000000-0000-4000-8000-000000000002';
    expect(() => scope.assertAllowed(disallowed)).toThrow(ForbiddenException);
    expect(() => scope.assertVisible(disallowed)).toThrow(NotFoundException);
  });
});
