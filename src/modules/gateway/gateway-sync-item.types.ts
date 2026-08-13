export type GatewaySyncItemStatus = 'PENDING' | 'RUNNING' | 'RETRY' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

export interface GatewaySyncItemDispatch {
  id: string;
  syncRunId: string;
  sessionId: string;
  groupId: string;
}

export interface ClaimedGatewaySyncItem extends GatewaySyncItemDispatch {
  leaseToken: string;
  attemptNumber: number;
  syncEpoch: string;
  observedSummaryFingerprint: string | null;
}

export interface SyncItemWriteFence {
  itemId: string;
  syncRunId: string;
  sessionId: string;
  leaseToken: string;
  syncEpoch: string;
}

export interface GatewaySyncFailurePolicy {
  retryable: boolean;
  ratePressure: boolean;
  code: string;
}
