import { Injectable } from '@nestjs/common';
import type { GroupDto, GroupMemberDto } from '../../contracts/groups/group.dto';
import type { GroupQueryDto } from '../../contracts/groups/group-query.dto';
import type { SessionDto } from '../../contracts/sessions/session.dto';
import type { SyncRunDto } from '../../contracts/sessions/sync-run.dto';
import { GatewaySyncMode } from '../../contracts/sessions/sync-request.dto';
import { DatabaseService } from '../../core/database/database.service';
import {
  type OpenWAGroup,
  type OpenWAGroupSummary,
  type OpenWASession,
} from '../../integrations/openwa/openwa.client';
import type { GroupSendCapabilityReason } from './group-capability';
import type { GroupIntentWriteFence, SyncItemWriteFence } from './gateway-sync-item.types';
import { ContactRepository } from '../contacts/contact.repository';
import {
  GatewaySyncRunRepository,
  type ClaimedSyncRun,
  type SyncAttemptResult,
} from './gateway-sync-run.repository';
import { GatewayGroupQueryRepository } from './gateway-group-query.repository';
import {
  GatewayCapabilityRepository,
  type CapabilityRefreshAttemptResult,
  type ClaimedCapabilityRefresh,
} from './gateway-capability.repository';
import {
  GatewayWriteFenceRepository,
  type SyncWriteFence,
} from './gateway-write-fence.repository';
import { GatewayGroupSnapshotRepository } from './gateway-group-snapshot.repository';

export type { ClaimedSyncRun, SyncAttemptResult } from './gateway-sync-run.repository';
export type {
  CapabilityRefreshAttemptResult,
  ClaimedCapabilityRefresh,
} from './gateway-capability.repository';
export type { SyncWriteFence } from './gateway-write-fence.repository';

interface SessionRow {
  id: string;
  name: string;
  status: string;
  phone: string | null;
  push_name: string | null;
  connected_at: Date | null;
  last_active_at: Date | null;
  engine_loaded: boolean;
  last_error: string | null;
  restriction: Record<string, unknown> | null;
  gateway_created_at: Date;
  gateway_updated_at: Date;
  synced_at: Date;
}

const mapSession = (row: SessionRow): SessionDto => ({
  id: row.id,
  name: row.name,
  status: row.status,
  phone: row.phone,
  pushName: row.push_name,
  connectedAt: row.connected_at,
  lastActiveAt: row.last_active_at,
  engineLoaded: row.engine_loaded,
  lastError: row.last_error,
  restriction: row.restriction,
  gatewayCreatedAt: row.gateway_created_at,
  gatewayUpdatedAt: row.gateway_updated_at,
  syncedAt: row.synced_at,
});

@Injectable()
export class GatewayRepository {
  private readonly syncRuns: GatewaySyncRunRepository;
  private readonly groupQueries: GatewayGroupQueryRepository;
  private readonly capabilities: GatewayCapabilityRepository;
  private readonly fences = new GatewayWriteFenceRepository();
  private readonly groupSnapshots: GatewayGroupSnapshotRepository;

  constructor(
    private readonly database: DatabaseService,
    private readonly contacts: ContactRepository,
    private readonly readContactProjection = false,
    syncRuns?: GatewaySyncRunRepository,
  ) {
    this.syncRuns = syncRuns ?? new GatewaySyncRunRepository(database);
    this.groupQueries = new GatewayGroupQueryRepository(database, readContactProjection);
    this.capabilities = new GatewayCapabilityRepository(database);
    this.groupSnapshots = new GatewayGroupSnapshotRepository(database, contacts, this.fences);
  }

  async upsertSession(session: OpenWASession, syncFence?: SyncWriteFence): Promise<SessionDto> {
    const sql = `INSERT INTO gateway_sessions
         (id, name, status, phone, push_name, connected_at, last_active_at, engine_loaded,
         last_error, restriction, gateway_created_at, gateway_updated_at,
         status_observed_at, restriction_observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$12,$12)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         status = CASE WHEN EXCLUDED.status_observed_at > gateway_sessions.status_observed_at
           THEN EXCLUDED.status ELSE gateway_sessions.status END,
         phone = EXCLUDED.phone,
         push_name = EXCLUDED.push_name, connected_at = EXCLUDED.connected_at,
         last_active_at = EXCLUDED.last_active_at, engine_loaded = EXCLUDED.engine_loaded,
         last_error = EXCLUDED.last_error,
         restriction = CASE WHEN EXCLUDED.restriction_observed_at > gateway_sessions.restriction_observed_at
           THEN EXCLUDED.restriction ELSE gateway_sessions.restriction END,
         status_observed_at = GREATEST(gateway_sessions.status_observed_at, EXCLUDED.status_observed_at),
         restriction_observed_at = GREATEST(gateway_sessions.restriction_observed_at,
           EXCLUDED.restriction_observed_at),
         gateway_updated_at = GREATEST(gateway_sessions.gateway_updated_at, EXCLUDED.gateway_updated_at),
         synced_at = now(), updated_at = now()
       RETURNING *`;
    const values = [session.id, session.name, session.status, session.phone ?? null, session.pushName ?? null,
      session.connectedAt ?? null, session.lastActive ?? null, session.engineLoaded,
      session.lastError ?? null, session.restriction == null ? null : JSON.stringify(session.restriction),
      session.createdAt, session.updatedAt];
    if (syncFence) {
      return this.database.transaction(async client => {
        await this.fences.assertSyncWriteOwnership(client, session.id, syncFence);
        const result = await client.query<SessionRow>(sql, values);
        return mapSession(result.rows[0]!);
      });
    }
    const result = await this.database.query<SessionRow>(sql, values);
    return mapSession(result.rows[0]!);
  }

  async listSessions(allowedIds: string[]): Promise<SessionDto[]> {
    const result = await this.database.query<SessionRow>(
      'SELECT * FROM gateway_sessions WHERE id = ANY($1::text[]) ORDER BY name, id', [allowedIds],
    );
    return result.rows.map(mapSession);
  }

  async findSession(id: string): Promise<SessionDto | null> {
    const result = await this.database.query<SessionRow>('SELECT * FROM gateway_sessions WHERE id = $1', [id]);
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async isSessionSendable(id: string): Promise<boolean> {
    const result = await this.database.query<{ sendable: boolean }>(
      `SELECT status = 'ready' AND engine_loaded = true AND restriction IS NULL AS sendable
       FROM gateway_sessions WHERE id = $1`, [id],
    );
    return result.rows[0]?.sendable === true;
  }

  async replaceGroupSummaries(
    sessionId: string,
    groups: OpenWAGroupSummary[],
    syncFence: SyncWriteFence,
  ): Promise<void> {
    return this.groupSnapshots.replaceGroupSummaries(sessionId, groups, syncFence);
  }

  async upsertGroupDetails(
    sessionId: string,
    group: OpenWAGroup,
    options: {
      expectedRevision?: number;
      capabilityLeaseToken?: string;
      syncFence?: SyncWriteFence;
      syncItemFence?: SyncItemWriteFence;
      groupIntentFence?: GroupIntentWriteFence;
    } = {},
  ): Promise<{ members: number; applied: boolean }> {
    return this.groupSnapshots.upsertGroupDetails(sessionId, group, options);
  }

  async invalidateGroupCapability(
    sessionId: string,
    groupId: string,
    reason: GroupSendCapabilityReason,
  ): Promise<boolean> {
    return this.capabilities.invalidate(sessionId, groupId, reason);
  }

  async listGroupsNeedingCapabilityRefresh(limit: number): Promise<Array<{
    sessionId: string;
    groupId: string;
    revision: number;
  }>> {
    return this.capabilities.listNeedingRefresh(limit);
  }

  async claimCapabilityRefresh(
    sessionId: string,
    groupId: string,
    expectedRevision: number,
  ): Promise<ClaimedCapabilityRefresh | null> {
    return this.capabilities.claim(sessionId, groupId, expectedRevision);
  }

  async failCapabilityRefreshAttempt(
    sessionId: string,
    groupId: string,
    expectedRevision: number,
    leaseToken: string,
    error: string,
    retryable = true,
  ): Promise<CapabilityRefreshAttemptResult> {
    return this.capabilities.failAttempt(
      sessionId, groupId, expectedRevision, leaseToken, error, retryable,
    );
  }

  async recoverExpiredCapabilityRefreshes(): Promise<number> {
    return this.capabilities.recoverExpired();
  }

  async listGroups(query: GroupQueryDto): Promise<{ data: GroupDto[]; total: number }> {
    return this.groupQueries.list(query);
  }

  async findGroup(sessionId: string, groupId: string, activeOnly = true): Promise<GroupDto | null> {
    return this.groupQueries.find(sessionId, groupId, activeOnly);
  }

  async listMembers(
    sessionId: string,
    groupId: string,
    limit: number,
    offset: number,
    query?: string,
  ): Promise<{ data: GroupMemberDto[]; total: number; datasetRevision: number }> {
    return this.groupQueries.listMembers(sessionId, groupId, limit, offset, query);
  }

  async createSyncRun(sessionId: string, mode: GatewaySyncMode = GatewaySyncMode.FULL): Promise<SyncRunDto> {
    return this.syncRuns.create(sessionId, mode);
  }

  async findSyncRunProgress(id: string, sessionId: string): Promise<{
    groupIds: Set<string>;
    groups: number;
    members: number;
  }> {
    return this.syncRuns.findProgress(id, sessionId);
  }

  async findSyncRun(id: string): Promise<SyncRunDto | null> {
    return this.syncRuns.find(id);
  }

  async listPendingSyncRuns(limit: number): Promise<SyncRunDto[]> {
    return this.syncRuns.listPending(limit);
  }

  async recoverExpiredSyncRuns(): Promise<number> {
    return this.syncRuns.recoverExpired();
  }

  async claimSyncRun(id: string): Promise<ClaimedSyncRun | null> {
    return this.syncRuns.claim(id);
  }

  async renewSyncLease(id: string, leaseToken: string): Promise<boolean> {
    return this.syncRuns.renewLease(id, leaseToken);
  }

  async completeSyncRun(id: string, leaseToken: string, groups: number, members: number): Promise<boolean> {
    return this.syncRuns.complete(id, leaseToken, groups, members);
  }

  async failSyncRunAttempt(
    id: string,
    leaseToken: string,
    groups: number,
    members: number,
    error: string,
  ): Promise<SyncAttemptResult> {
    return this.syncRuns.failAttempt(id, leaseToken, groups, members, error);
  }

}
