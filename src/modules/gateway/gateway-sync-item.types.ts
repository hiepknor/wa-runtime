export type GatewaySyncItemStatus = 'PENDING' | 'RUNNING' | 'RETRY' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

export interface GatewaySyncItemDispatch {
  id: string;
  syncRunId: string;
  sessionId: string;
  groupId: string;
  availableAt: Date;
}

export interface ClaimedGatewaySyncItem extends Omit<GatewaySyncItemDispatch, 'availableAt'> {
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

export interface GroupIntentWriteFence {
  sessionId: string;
  groupId: string;
  leaseToken: string;
  claimedRevision: number;
}

export interface GatewaySyncFailurePolicy {
  retryable: boolean;
  ratePressure: boolean;
  reduceRate?: boolean;
  retryAfterMs?: number;
  code: string;
}
