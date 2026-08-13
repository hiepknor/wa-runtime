import { Injectable } from '@nestjs/common';
import type { FullGatewaySyncPayload, GroupCapabilityRefreshPayload, GroupReconciliationPayload, TargetedGroupReconciliationPayload } from './gateway-sync.types';
import { GatewaySyncService } from './gateway-sync.service';

@Injectable()
export class GatewaySyncProcessorService {
  constructor(private readonly sync: GatewaySyncService) {}

  process(name: string, payload: FullGatewaySyncPayload | GroupCapabilityRefreshPayload | GroupReconciliationPayload | TargetedGroupReconciliationPayload): Promise<unknown> {
    if (name === 'refresh-group-capability') {
      const refresh = payload as GroupCapabilityRefreshPayload;
      return this.sync.refreshGroupCapability(refresh.sessionId, refresh.groupId, refresh.expectedRevision);
    }
    if (name === 'reconcile-session-group') {
      return this.sync.reconcileGroup((payload as GroupReconciliationPayload).itemId);
    }
    if (name === 'reconcile-targeted-group') {
      const targeted = payload as TargetedGroupReconciliationPayload;
      return this.sync.reconcileTargetedGroup(targeted.sessionId, targeted.groupId);
    }
    const full = payload as FullGatewaySyncPayload;
    return this.sync.perform(full.syncRunId);
  }
}
