import { ConflictException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import type { SyncRunDto } from '../../contracts/sessions/sync-run.dto';
import { GatewaySyncMode } from '../../contracts/sessions/sync-request.dto';
import { OpenWAClient, OpenWAHttpError, OpenWAResponseValidationError } from '../../integrations/openwa/openwa.client';
import { GatewayRepository, type SyncWriteFence } from './gateway.repository';
import { GatewaySyncItemRepository } from './gateway-sync-item.repository';
import { GatewaySyncModeConflictError } from './gateway-sync.types';
import { GatewayGroupIntentRepository } from './gateway-group-intent.repository';
import { ContactSyncService } from '../contacts/contact-sync.service';

@Injectable()
export class GatewaySyncService {
  private readonly logger = new Logger(GatewaySyncService.name);

  constructor(
    private readonly repository: GatewayRepository,
    private readonly items: GatewaySyncItemRepository,
    private readonly openwa: OpenWAClient,
    private readonly groupIntents: GatewayGroupIntentRepository,
    private readonly contactSync: ContactSyncService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async request(sessionId: string, mode: GatewaySyncMode = GatewaySyncMode.FULL): Promise<SyncRunDto> {
    if (!this.config.OPENWA_ALLOWED_SESSION_IDS.includes(sessionId)) {
      throw new ForbiddenException('Session is not in OPENWA_ALLOWED_SESSION_IDS');
    }
    try {
      return await this.repository.createSyncRun(sessionId, mode);
    } catch (error) {
      if (error instanceof GatewaySyncModeConflictError) {
        throw new ConflictException({
          statusCode: 409, code: 'SYNC_MODE_CONFLICT', message: error.message,
          activeRunId: error.activeRunId, activeMode: error.activeMode,
        });
      }
      throw error;
    }
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
      if (discovery.deferred) {
        this.logger.warn({
          event: 'gateway.sync.discovery.suspicious', syncRunId, sessionId,
          groupsDiscovered: discovery.discovered,
        });
        return { skipped: true };
      }
      this.logger.log({
        event: 'gateway.sync.discovery.completed', syncRunId, sessionId,
        mode: run.syncType, groupsDiscovered: discovery.discovered,
        groupsScheduled: discovery.scheduled,
      });
      if (run.syncType === GatewaySyncMode.FULL && this.config.CONTACT_SNAPSHOT_SYNC_ENABLED) {
        try {
          await this.contactSync.reconcileObservedContacts(sessionId);
        } catch {
          this.logger.warn({ event: 'contacts.snapshot.degraded', syncRunId, sessionId });
        }
      }
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
    let ownershipLost = false;
    let renewalInFlight = false;
    const heartbeat = setInterval(() => {
      if (renewalInFlight || ownershipLost) return;
      renewalInFlight = true;
      void this.items.renewLease(claim.id, claim.leaseToken)
        .then(renewed => { if (!renewed) ownershipLost = true; })
        .catch(() => { ownershipLost = true; })
        .finally(() => { renewalInFlight = false; });
    }, 30_000);
    heartbeat.unref();
    let stage: 'UPSTREAM' | 'PERSISTENCE' = 'UPSTREAM';
    try {
      const group = await this.openwa.getGroup(claim.sessionId, claim.groupId);
      stage = 'PERSISTENCE';
      if (ownershipLost || !await this.items.renewLease(claim.id, claim.leaseToken)) {
        this.logger.warn({
          event: 'gateway.sync.item.lost_ownership', syncRunId: claim.syncRunId,
          sessionId: claim.sessionId,
        });
        return { skipped: true };
      }
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
      if (stage === 'UPSTREAM' && error instanceof OpenWAHttpError && error.status === 404) {
        await this.items.skip(claim.id, claim.leaseToken, error.message);
        this.logger.warn({
          event: 'gateway.sync.item.skipped', syncRunId: claim.syncRunId,
          sessionId: claim.sessionId, reason: 'GROUP_NOT_FOUND',
        });
        return { skipped: true };
      }
      const policy = stage === 'UPSTREAM'
        ? this.classifyGroupReadFailure(error)
        : { retryable: true, ratePressure: false, code: 'PERSISTENCE_ERROR' };
      const outcome = await this.items.fail(
        claim.id,
        claim.leaseToken,
        policy.code,
        policy,
      );
      this.logger.warn({
        event: 'gateway.sync.item.failed', syncRunId: claim.syncRunId,
        sessionId: claim.sessionId, outcome,
        statusCode: error instanceof OpenWAHttpError ? error.status : undefined,
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  async reconcileTargetedGroup(
    sessionId: string,
    groupId: string,
  ): Promise<{ members?: number; skipped?: boolean; pending?: boolean }> {
    if (!this.config.OPENWA_ALLOWED_SESSION_IDS.includes(sessionId)) {
      throw new ForbiddenException('Session is not in OPENWA_ALLOWED_SESSION_IDS');
    }
    const claim = await this.groupIntents.claim(sessionId, groupId);
    if (!claim) return { skipped: true };
    const startedAt = Date.now();
    let ownershipLost = false;
    let renewalInFlight = false;
    const heartbeat = setInterval(() => {
      if (renewalInFlight || ownershipLost) return;
      renewalInFlight = true;
      void this.groupIntents.renewLease(sessionId, groupId, claim.leaseToken)
        .then(renewed => { if (!renewed) ownershipLost = true; })
        .catch(() => { ownershipLost = true; })
        .finally(() => { renewalInFlight = false; });
    }, 30_000);
    heartbeat.unref();
    let stage: 'UPSTREAM' | 'PERSISTENCE' = 'UPSTREAM';
    try {
      const group = await this.openwa.getGroup(sessionId, groupId);
      stage = 'PERSISTENCE';
      if (ownershipLost || !await this.groupIntents.renewLease(sessionId, groupId, claim.leaseToken)) {
        return { skipped: true };
      }
      const result = await this.repository.upsertGroupDetails(sessionId, group, {
        groupIntentFence: {
          sessionId, groupId, leaseToken: claim.leaseToken,
          claimedRevision: claim.requestedRevision,
        },
      });
      const outcome = await this.groupIntents.complete(
        sessionId, groupId, claim.leaseToken, claim.requestedRevision,
      );
      if (outcome === 'LOST_OWNERSHIP') return { skipped: true };
      this.logger.log({
        event: 'gateway.group_reconciliation.completed', source: 'WEBHOOK',
        sessionId, durationMs: Date.now() - startedAt,
        queueAgeMs: Date.now() - claim.requestedAt.valueOf(),
        coalescedEvents: claim.coalescedCount, outcome,
      });
      return { members: result.members, pending: outcome === 'PENDING' };
    } catch (error) {
      if (stage === 'UPSTREAM' && error instanceof OpenWAHttpError && error.status === 404) {
        await this.groupIntents.skipMissing(sessionId, groupId, claim.leaseToken, claim.requestedRevision);
        this.logger.warn({
          event: 'gateway.group_reconciliation.skipped', source: 'WEBHOOK', sessionId,
          reason: 'GROUP_NOT_FOUND', durationMs: Date.now() - startedAt,
        });
        return { skipped: true };
      }
      const policy = stage === 'UPSTREAM'
        ? this.classifyGroupReadFailure(error)
        : { retryable: true, ratePressure: false, code: 'PERSISTENCE_ERROR' };
      const outcome = await this.groupIntents.fail(
        sessionId, groupId, claim.leaseToken, claim.requestedRevision, policy,
      );
      this.logger.warn({
        event: 'gateway.group_reconciliation.failed', source: 'WEBHOOK', sessionId,
        outcome, code: policy.code, durationMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private classifyGroupReadFailure(error: unknown) {
    if (error instanceof OpenWAResponseValidationError) {
      return { retryable: false, ratePressure: false, code: 'INVALID_RESPONSE' };
    }
    if (error instanceof OpenWAHttpError) {
      if (error.status === 429) {
        return {
          retryable: true, ratePressure: true, reduceRate: true,
          retryAfterMs: error.retryAfterMs, code: 'RATE_LIMITED',
        };
      }
      if (error.status >= 500) return { retryable: true, ratePressure: true, code: 'UPSTREAM_SERVER_ERROR' };
      if (error.status === 409) return { retryable: true, ratePressure: false, code: 'UPSTREAM_CONFLICT' };
      return { retryable: false, ratePressure: false, code: `UPSTREAM_HTTP_${error.status}` };
    }
    return { retryable: true, ratePressure: true, code: 'UPSTREAM_NETWORK_ERROR' };
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
      await this.items.releaseSessionRequest(sessionId, pacingLease);
      return { applied: false };
    }
    let stage: 'UPSTREAM' | 'PERSISTENCE' = 'UPSTREAM';
    try {
      const group = await this.openwa.getGroup(sessionId, groupId);
      stage = 'PERSISTENCE';
      const result = await this.repository.upsertGroupDetails(
        sessionId,
        group,
        { expectedRevision, capabilityLeaseToken: claim.leaseToken },
      );
      await this.items.recordSessionRequestOutcome(sessionId, pacingLease, true);
      return { applied: result.applied };
    } catch (error) {
      const policy = stage === 'UPSTREAM'
        ? this.classifyGroupReadFailure(error)
        : { retryable: true, ratePressure: false, code: 'PERSISTENCE_ERROR' };
      await this.items.recordSessionRequestOutcome(
        sessionId, pacingLease, false, policy.ratePressure, policy.reduceRate === true,
      );
      await this.repository.failCapabilityRefreshAttempt(
        sessionId,
        groupId,
        expectedRevision,
        claim.leaseToken,
        policy.code,
        policy.retryable,
      );
      throw error;
    }
  }
}
