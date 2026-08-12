import { ForbiddenException, Injectable } from '@nestjs/common';
import { runtimeConfig } from '../../core/config/runtime-config';
import type { SyncRunDto } from '../../contracts/sessions/sync-run.dto';
import { OpenWAClient } from '../../integrations/openwa/openwa.client';
import { GatewayRepository } from './gateway.repository';

@Injectable()
export class GatewaySyncService {
  private readonly config = runtimeConfig();

  constructor(
    private readonly repository: GatewayRepository,
    private readonly openwa: OpenWAClient,
  ) {}

  async request(sessionId: string): Promise<SyncRunDto> {
    if (!this.config.OPENWA_ALLOWED_SESSION_IDS.includes(sessionId)) {
      throw new ForbiddenException('Session is not in OPENWA_ALLOWED_SESSION_IDS');
    }
    return this.repository.createSyncRun(sessionId);
  }

  async perform(syncRunId: string): Promise<{ groups?: number; members?: number; skipped?: boolean }> {
    const claim = await this.repository.claimSyncRun(syncRunId);
    if (!claim) return { skipped: true };
    const { sessionId, leaseToken } = claim;
    let groupsSynced = 0;
    let membersSynced = 0;
    let ownershipLost = false;
    let renewalInFlight = false;
    const heartbeat = setInterval(() => {
      if (renewalInFlight || ownershipLost) return;
      renewalInFlight = true;
      void this.repository.renewSyncLease(syncRunId, leaseToken)
        .then(renewed => { if (!renewed) ownershipLost = true; })
        .catch(() => { ownershipLost = true; })
        .finally(() => { renewalInFlight = false; });
    }, 30_000);
    heartbeat.unref();
    try {
      await this.openwa.assertCompatibleRelease();
      await this.assertSyncOwnership(syncRunId, leaseToken, ownershipLost);
      const session = await this.openwa.getSession(sessionId);
      await this.repository.upsertSession(session);
      await this.assertSyncOwnership(syncRunId, leaseToken, ownershipLost);
      const groups = await this.openwa.listGroups(sessionId);
      await this.assertSyncOwnership(syncRunId, leaseToken, ownershipLost);
      await this.repository.replaceGroupSummaries(sessionId, groups);
      const concurrency = 4;
      for (let offset = 0; offset < groups.length; offset += concurrency) {
        await this.assertSyncOwnership(syncRunId, leaseToken, ownershipLost);
        const batch = groups.slice(offset, offset + concurrency);
        const results = await Promise.all(batch.map(async summary => {
          const group = await this.openwa.getGroup(sessionId, summary.id);
          return this.repository.upsertGroupDetails(sessionId, group);
        }));
        for (const result of results) {
          membersSynced += result.members;
          if (result.applied) groupsSynced += 1;
        }
      }
      if (!await this.repository.completeSyncRun(syncRunId, leaseToken, groupsSynced, membersSynced)) {
        return { skipped: true };
      }
      return { groups: groupsSynced, members: membersSynced };
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error);
      await this.repository.failSyncRunAttempt(
        syncRunId,
        leaseToken,
        groupsSynced,
        membersSynced,
        description,
      );
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async assertSyncOwnership(
    syncRunId: string,
    leaseToken: string,
    ownershipLost: boolean,
  ): Promise<void> {
    if (ownershipLost || !await this.repository.renewSyncLease(syncRunId, leaseToken)) {
      throw new Error('Gateway sync attempt lost ownership');
    }
  }

  async refreshGroupCapability(
    sessionId: string,
    groupId: string,
    expectedRevision: number,
  ): Promise<{ applied: boolean }> {
    if (!this.config.OPENWA_ALLOWED_SESSION_IDS.includes(sessionId)) {
      throw new ForbiddenException('Session is not in OPENWA_ALLOWED_SESSION_IDS');
    }
    const claim = await this.repository.claimCapabilityRefresh(sessionId, groupId, expectedRevision);
    if (!claim) return { applied: false };
    try {
      const group = await this.openwa.getGroup(sessionId, groupId);
      const result = await this.repository.upsertGroupDetails(
        sessionId,
        group,
        expectedRevision,
        claim.leaseToken,
      );
      return { applied: result.applied };
    } catch (error) {
      await this.repository.failCapabilityRefreshAttempt(
        sessionId,
        groupId,
        expectedRevision,
        claim.leaseToken,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
}
