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
