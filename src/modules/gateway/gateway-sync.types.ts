export interface FullGatewaySyncPayload {
  syncRunId: string;
  sessionId: string;
}

export interface GroupCapabilityRefreshPayload {
  sessionId: string;
  groupId: string;
  expectedRevision: number;
}
