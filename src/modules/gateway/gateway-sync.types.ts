import type { GatewaySyncMode } from '../../contracts/sessions/sync-request.dto';

export interface FullGatewaySyncPayload {
  syncRunId: string;
  sessionId: string;
}

export interface GroupReconciliationPayload {
  itemId: string;
  syncRunId: string;
  sessionId: string;
  groupId: string;
}

export interface GroupCapabilityRefreshPayload {
  sessionId: string;
  groupId: string;
  expectedRevision: number;
}

export interface TargetedGroupReconciliationPayload {
  sessionId: string;
  groupId: string;
  requestedRevision: number;
}

export class GatewaySyncModeConflictError extends Error {
  constructor(
    readonly activeRunId: string,
    readonly activeMode: GatewaySyncMode,
  ) {
    super('A different synchronization mode is already active');
    this.name = 'GatewaySyncModeConflictError';
  }
}
