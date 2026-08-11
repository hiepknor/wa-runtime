export type GroupSendCapabilityStatus = 'ALLOWED' | 'DENIED' | 'UNKNOWN';

export type GroupSendCapabilityReason =
  | 'SEND_ALLOWED'
  | 'GROUP_INACTIVE'
  | 'GROUP_READ_ONLY'
  | 'ADMIN_ONLY'
  | 'ADMIN_STATUS_UNKNOWN'
  | 'METADATA_INCOMPLETE'
  | 'GROUP_CHANGED'
  | 'GATEWAY_PERMISSION_DENIED'
  | 'MANUAL_REFRESH'
  | 'REFRESH_FAILED';

export interface GroupCapabilityInput {
  isActive: boolean;
  isReadOnly: boolean | null;
  isAnnounce: boolean | null;
  isAdmin: boolean | null;
  hasDetails: boolean;
}

export interface GroupCapabilityDecision {
  status: GroupSendCapabilityStatus;
  reason: GroupSendCapabilityReason;
}

export function evaluateGroupCapability(input: GroupCapabilityInput): GroupCapabilityDecision {
  if (!input.isActive) return { status: 'DENIED', reason: 'GROUP_INACTIVE' };
  if (!input.hasDetails) return { status: 'UNKNOWN', reason: 'METADATA_INCOMPLETE' };
  if (input.isReadOnly === true) return { status: 'DENIED', reason: 'GROUP_READ_ONLY' };
  if (input.isAnnounce === true && input.isAdmin === false) {
    return { status: 'DENIED', reason: 'ADMIN_ONLY' };
  }
  if (input.isAnnounce === true && input.isAdmin === null) {
    return { status: 'UNKNOWN', reason: 'ADMIN_STATUS_UNKNOWN' };
  }
  if (input.isAnnounce === false && input.isReadOnly === false) {
    return { status: 'ALLOWED', reason: 'SEND_ALLOWED' };
  }
  return { status: 'UNKNOWN', reason: 'METADATA_INCOMPLETE' };
}
