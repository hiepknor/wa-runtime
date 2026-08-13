import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { runtimeConfig } from '../../core/config/runtime-config';
import type { SyncRunDto } from '../../contracts/sessions/sync-run.dto';
import { GatewaySyncMode } from '../../contracts/sessions/sync-request.dto';
import { OpenWAClient, OpenWAHttpError, OpenWAResponseValidationError } from '../../integrations/openwa/openwa.client';
import { GatewayRepository, type SyncWriteFence } from './gateway.repository';
import { GatewaySyncItemRepository } from './gateway-sync-item.repository';

@Injectable()
export class GatewaySyncService {
  private readonly config = runtimeConfig();
  private readonly logger = new Logger(GatewaySyncService.name);

  constructor(
    private readonly repository: GatewayRepository,
    private readonly items: GatewaySyncItemRepository,
    private readonly openwa: OpenWAClient,
  ) {}

  async request(sessionId: string, mode: GatewaySyncMode = GatewaySyncMode.FULL): Promise<SyncRunDto> {
    if (!this.config.OPENWA_ALLOWED_SESSION_IDS.includes(sessionId)) {
      throw new ForbiddenException('Session is not in OPENWA_ALLOWED_SESSION_IDS');
    }
    return this.repository.createSyncRun(sessionId, mode);
  }

  async perform(syncRunId: string): Promise<{ groups?: number; members?: number; skipped?: boolean }> {
    const claim = await this.repository.claimSyncRun(syncRunId);
    if (!claim) return { skipped: true };
    const { sessionId, leaseToken, syncEpoch } = claim;
    const syncFence: SyncWriteFence = { syncRunId, leaseToken, syncEpoch };
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
      await this.repository.upsertSession(session, syncFence);
      await this.assertSyncOwnership(syncRunId, leaseToken, ownershipLost);
      const groups = await this.openwa.listGroups(sessionId);
      await this.assertSyncOwnership(syncRunId, leaseToken, ownershipLost);
      const run = await this.repository.findSyncRun(syncRunId);
      if (!run) return { skipped: true };
      const discovery = await this.items.publishDiscovery(
        syncFence, sessionId, run.syncType, groups,
      );
      this.logger.log({
        event: 'gateway.sync.discovery.completed', syncRunId, sessionId,
        mode: run.syncType, groupsDiscovered: discovery.discovered,
        groupsScheduled: discovery.scheduled,
      });
      return { groups: discovery.discovered, members: 0 };
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

  async reconcileGroup(itemId: string): Promise<{ members?: number; skipped?: boolean }> {
    const claim = await this.items.claim(itemId);
    if (!claim) return { skipped: true };
    try {
      const group = await this.openwa.getGroup(claim.sessionId, claim.groupId);
      const result = await this.repository.upsertGroupDetails(claim.sessionId, group, {
        syncItemFence: {
          itemId: claim.id,
          syncRunId: claim.syncRunId,
          sessionId: claim.sessionId,
          leaseToken: claim.leaseToken,
          syncEpoch: claim.syncEpoch,
        },
      });
      if (!result.applied || !await this.items.complete(claim.id, claim.leaseToken, result.members)) {
        return { skipped: true };
      }
      this.logger.log({
        event: 'gateway.sync.item.completed', syncRunId: claim.syncRunId,
        sessionId: claim.sessionId, membersSynced: result.members,
      });
      return { members: result.members };
    } catch (error) {
      if (error instanceof OpenWAHttpError && error.status === 404) {
        await this.items.skip(claim.id, claim.leaseToken, error.message);
        this.logger.warn({
          event: 'gateway.sync.item.skipped', syncRunId: claim.syncRunId,
          sessionId: claim.sessionId, reason: 'GROUP_NOT_FOUND',
        });
        return { skipped: true };
      }
      const outcome = await this.items.fail(
        claim.id,
        claim.leaseToken,
        error instanceof Error ? error.message : String(error),
        this.isRetryableGroupRead(error),
      );
      this.logger.warn({
        event: 'gateway.sync.item.failed', syncRunId: claim.syncRunId,
        sessionId: claim.sessionId, outcome,
        statusCode: error instanceof OpenWAHttpError ? error.status : undefined,
      });
      throw error;
    }
  }

  private isRetryableGroupRead(error: unknown): boolean {
    if (error instanceof OpenWAResponseValidationError) return false;
    if (error instanceof OpenWAHttpError) {
      return error.status === 409 || error.status === 429 || error.status >= 500;
    }
    return true;
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
    const pacingLease = await this.items.reserveSessionRequest(sessionId);
    if (!pacingLease) return { applied: false };
    const claim = await this.repository.claimCapabilityRefresh(sessionId, groupId, expectedRevision);
    if (!claim) {
      await this.items.recordSessionRequestOutcome(sessionId, pacingLease, true);
      return { applied: false };
    }
    try {
      const group = await this.openwa.getGroup(sessionId, groupId);
      const result = await this.repository.upsertGroupDetails(
        sessionId,
        group,
        { expectedRevision, capabilityLeaseToken: claim.leaseToken },
      );
      await this.items.recordSessionRequestOutcome(sessionId, pacingLease, true);
      return { applied: result.applied };
    } catch (error) {
      await this.items.recordSessionRequestOutcome(sessionId, pacingLease, false);
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
