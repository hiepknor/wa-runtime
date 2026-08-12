import { Injectable } from '@nestjs/common';
import type { FullGatewaySyncPayload, GroupCapabilityRefreshPayload } from './gateway-sync.types';
import { GatewaySyncService } from './gateway-sync.service';

@Injectable()
export class GatewaySyncProcessorService {
  constructor(private readonly sync: GatewaySyncService) {}

  process(name: string, payload: FullGatewaySyncPayload | GroupCapabilityRefreshPayload): Promise<unknown> {
    if (name === 'refresh-group-capability') {
      const refresh = payload as GroupCapabilityRefreshPayload;
      return this.sync.refreshGroupCapability(refresh.sessionId, refresh.groupId, refresh.expectedRevision);
    }
    const full = payload as FullGatewaySyncPayload;
    return this.sync.perform(full.syncRunId, full.sessionId);
  }
}
