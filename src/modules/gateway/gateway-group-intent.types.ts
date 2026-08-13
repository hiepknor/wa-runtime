import type { GatewaySyncFailurePolicy } from './gateway-sync-item.types';

export interface GatewayGroupIntentDispatch {
  sessionId: string;
  groupId: string;
  requestedRevision: number;
  availableAt: Date;
}

export interface ClaimedGatewayGroupIntent {
  sessionId: string;
  groupId: string;
  requestedRevision: number;
  leaseToken: string;
  attemptNumber: number;
  coalescedCount: number;
  requestedAt: Date;
}

export type GatewayGroupIntentFailurePolicy = GatewaySyncFailurePolicy;
