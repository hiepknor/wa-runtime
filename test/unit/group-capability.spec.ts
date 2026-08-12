import { describe, expect, it } from 'vitest';
import { evaluateGroupCapability } from '../../src/modules/gateway/group-capability';

describe('evaluateGroupCapability', () => {
  it.each([
    [{ isActive: false, isReadOnly: false, isAnnounce: false, isAdmin: false, hasDetails: true }, 'DENIED', 'GROUP_INACTIVE'],
    [{ isActive: true, isReadOnly: true, isAnnounce: false, isAdmin: true, hasDetails: true }, 'DENIED', 'GROUP_READ_ONLY'],
    [{ isActive: true, isReadOnly: false, isAnnounce: true, isAdmin: false, hasDetails: true }, 'DENIED', 'ADMIN_ONLY'],
    [{ isActive: true, isReadOnly: false, isAnnounce: true, isAdmin: null, hasDetails: true }, 'UNKNOWN', 'ADMIN_STATUS_UNKNOWN'],
    [{ isActive: true, isReadOnly: false, isAnnounce: false, isAdmin: false, hasDetails: true }, 'ALLOWED', 'SEND_ALLOWED'],
    [{ isActive: true, isReadOnly: null, isAnnounce: null, isAdmin: null, hasDetails: false }, 'UNKNOWN', 'METADATA_INCOMPLETE'],
  ] as const)('maps %j to %s/%s', (input, status, reason) => {
    expect(evaluateGroupCapability(input)).toEqual({ status, reason });
  });
});
