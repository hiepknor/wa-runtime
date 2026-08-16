import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CampaignStatus, type CampaignDto } from '../../contracts/campaigns/campaign.dto';
import type {
  CampaignTargetDto,
  CampaignTargetSourceDto,
} from '../../contracts/campaigns/campaign-target.dto';
import type { CampaignScheduleType } from '../../contracts/campaigns/create-campaign.dto';
import { DatabaseService } from '../../core/database/database.service';
import type { GroupSendCapabilityStatus } from '../gateway/group-capability';
import { GroupListRepository } from '../group-lists/group-list.repository';

interface CampaignRow {
  id: string;
  session_id: string;
  name: string;
  payload: { text: string };
  schedule_type: CampaignScheduleType;
  scheduled_at: Date | null;
  status: CampaignStatus;
  target_count: string | number;
  revision: string | number;
  targets_revision: string | number;
  target_source_group_list_id: string | null;
  target_source_group_list_name_snapshot: string | null;
  target_source_membership_revision: string | number | null;
  target_source_applied_at: Date | null;
  create_request_hash?: string | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CampaignDeletionResult {
  found: boolean;
  alreadyDeleted: boolean;
  deleted: boolean;
  revisionConflict: boolean;
  stateConflict: boolean;
  runConflict: boolean;
  currentRevision?: number;
  currentTargetsRevision?: number;
  currentStatus?: CampaignStatus;
}

interface TargetRow {
  group_id: string;
  group_name: string;
  enabled: boolean;
  send_capability: GroupSendCapabilityStatus;
  send_capability_reason: string;
  capability_checked_at: Date | null;
  capability_invalidated_at: Date | null;
  capability_revision: number;
}

const campaignSelect = `
  SELECT c.*,
    (SELECT count(*) FROM campaign_targets ct WHERE ct.campaign_id = c.id AND ct.enabled) AS target_count
  FROM campaigns c`;

const mapCampaign = (row: CampaignRow): CampaignDto => ({
  id: row.id,
  sessionId: row.session_id,
  name: row.name,
  text: row.payload.text,
  scheduleType: row.schedule_type,
  scheduledAt: row.scheduled_at,
  status: row.status,
  targetCount: Number(row.target_count),
  revision: Number(row.revision),
  targetsRevision: Number(row.targets_revision),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapTarget = (row: TargetRow): CampaignTargetDto => ({
  groupId: row.group_id,
  groupName: row.group_name,
  enabled: row.enabled,
  sendCapability: {
    status: row.send_capability,
    reason: row.send_capability_reason,
    checkedAt: row.capability_checked_at,
    invalidatedAt: row.capability_invalidated_at,
    revision: row.capability_revision,
  },
});

const mapTargetSource = (row: CampaignRow): CampaignTargetSourceDto | null =>
  row.target_source_group_list_id && row.target_source_group_list_name_snapshot
    && row.target_source_membership_revision && row.target_source_applied_at
    ? {
        type: 'GROUP_LIST',
        groupListId: row.target_source_group_list_id,
        groupListNameSnapshot: row.target_source_group_list_name_snapshot,
        membershipRevision: Number(row.target_source_membership_revision),
        appliedAt: row.target_source_applied_at,
      }
    : null;

@Injectable()
export class CampaignRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly groupLists: GroupListRepository,
  ) {}

  async sessionExists(sessionId: string): Promise<boolean> {
    const result = await this.database.query('SELECT 1 FROM gateway_sessions WHERE id = $1', [sessionId]);
    return result.rowCount === 1;
  }

  async create(input: {
    sessionId: string;
    name: string;
    text: string;
    scheduleType: CampaignScheduleType;
    scheduledAt: Date | null;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<{ campaign: CampaignDto; created: boolean; requestHash: string; deleted: boolean }> {
    return this.database.transaction(async client => {
      const existing = await client.query<CampaignRow>(
        `${campaignSelect} WHERE c.create_idempotency_key = $1::uuid FOR UPDATE OF c`,
        [input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        return {
          campaign: mapCampaign(row), created: false, requestHash: row.create_request_hash!,
          deleted: row.deleted_at !== null,
        };
      }

      const inserted = await client.query<CampaignRow>(
        `INSERT INTO campaigns
           (session_id, name, payload, schedule_type, scheduled_at, create_idempotency_key, create_request_hash)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6::uuid,$7)
         ON CONFLICT (create_idempotency_key) WHERE create_idempotency_key IS NOT NULL DO NOTHING
         RETURNING *, 0 AS target_count`,
        [input.sessionId, input.name, JSON.stringify({ text: input.text }), input.scheduleType, input.scheduledAt,
          input.idempotencyKey, input.requestHash],
      );
      if (inserted.rows[0]) {
        return {
          campaign: mapCampaign(inserted.rows[0]), created: true, requestHash: input.requestHash, deleted: false,
        };
      }

      const replay = await client.query<CampaignRow>(
        `${campaignSelect} WHERE c.create_idempotency_key = $1::uuid FOR UPDATE OF c`,
        [input.idempotencyKey],
      );
      const row = replay.rows[0];
      if (!row) throw new Error('Campaign idempotency conflict row was not visible after insert conflict');
      return {
        campaign: mapCampaign(row), created: false, requestHash: row.create_request_hash!,
        deleted: row.deleted_at !== null,
      };
    });
  }

  async find(id: string, includeDeleted = false): Promise<CampaignDto | null> {
    const result = await this.database.query<CampaignRow>(
      `${campaignSelect} WHERE c.id = $1${includeDeleted ? '' : ' AND c.deleted_at IS NULL'}`,
      [id],
    );
    return result.rows[0] ? mapCampaign(result.rows[0]) : null;
  }

  async list(input: {
    allowedSessionIds: string[];
    sessionId?: string;
    query?: string;
    exactCampaignId?: string;
    statuses?: CampaignStatus[];
    scheduleTypes?: CampaignScheduleType[];
    limit: number;
    offset: number;
  }) {
    const sessionIds = input.sessionId ? [input.sessionId] : input.allowedSessionIds;
    const normalizedQuery = input.query?.trim();
    const searchPattern = normalizedQuery
      ? `%${normalizedQuery.replace(/[\\%_]/g, '\\$&')}%`
      : null;
    const statuses = input.statuses?.length ? input.statuses : null;
    const scheduleTypes = input.scheduleTypes?.length ? input.scheduleTypes : null;
    return this.database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const values = [sessionIds, searchPattern, input.exactCampaignId ?? null, statuses, scheduleTypes];
      const predicate = `c.session_id = ANY($1::text[]) AND c.deleted_at IS NULL
        AND ($2::text IS NULL OR c.name ILIKE $2 ESCAPE '\\' OR c.id = $3::uuid)
        AND ($4::campaign_status[] IS NULL OR c.status = ANY($4))
        AND ($5::campaign_schedule_type[] IS NULL OR c.schedule_type = ANY($5))`;
      const rows = await client.query<CampaignRow>(
        `${campaignSelect} WHERE ${predicate}
         ORDER BY c.updated_at DESC, c.id ASC LIMIT $6 OFFSET $7`,
        [...values, input.limit, input.offset],
      );
      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM campaigns c WHERE ${predicate}`,
        values,
      );
      return { data: rows.rows.map(mapCampaign), total: Number(count.rows[0]?.count ?? 0) };
    });
  }

  async update(id: string, input: {
    name: string;
    text: string;
    scheduleType: CampaignScheduleType;
    scheduledAt: Date | null;
  }, expectedRevision: number): Promise<CampaignDto | null> {
    const result = await this.database.query<CampaignRow>(
      `WITH updated AS (
         UPDATE campaigns SET name = $2, payload = $3::jsonb, schedule_type = $4,
           scheduled_at = $5,
           revision = revision + CASE WHEN (name, payload, schedule_type, scheduled_at)
             IS DISTINCT FROM ($2, $3::jsonb, $4::campaign_schedule_type, $5::timestamptz) THEN 1 ELSE 0 END,
           updated_at = CASE WHEN (name, payload, schedule_type, scheduled_at)
             IS DISTINCT FROM ($2, $3::jsonb, $4::campaign_schedule_type, $5::timestamptz) THEN now() ELSE updated_at END
         WHERE id = $1 AND deleted_at IS NULL AND status = 'DRAFT' AND revision = $6 RETURNING *
       )
       SELECT updated.*,
         (SELECT count(*) FROM campaign_targets WHERE campaign_id = updated.id AND enabled) AS target_count
       FROM updated`,
      [id, input.name, JSON.stringify({ text: input.text }), input.scheduleType, input.scheduledAt, expectedRevision],
    );
    return result.rows[0] ? mapCampaign(result.rows[0]) : null;
  }

  async getTargetsSnapshot(campaignId: string): Promise<{
    campaign: CampaignDto;
    targets: CampaignTargetDto[];
    source: CampaignTargetSourceDto | null;
  } | null> {
    return this.database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const campaignResult = await client.query<CampaignRow>(
        `${campaignSelect} WHERE c.id = $1 AND c.deleted_at IS NULL`,
        [campaignId],
      );
      const row = campaignResult.rows[0];
      if (!row) return null;
      return {
        campaign: mapCampaign(row),
        targets: await this.listTargetsWithClient(client, campaignId),
        source: mapTargetSource(row),
      };
    });
  }

  async getPreflightSnapshot(campaignId: string): Promise<{
    campaign: CampaignDto;
    targets: CampaignTargetDto[];
  } | null> {
    return this.database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const campaignResult = await client.query<CampaignRow>(
        `${campaignSelect} WHERE c.id = $1 AND c.deleted_at IS NULL`,
        [campaignId],
      );
      const row = campaignResult.rows[0];
      if (!row) return null;
      return {
        campaign: mapCampaign(row),
        targets: await this.listTargetsWithClient(client, campaignId),
      };
    });
  }

  async replaceTargets(campaignId: string, groupIds: string[], expectedTargetsRevision: number): Promise<{
    targets: CampaignTargetDto[];
    missingGroupIds: string[];
    mismatchedGroupIds: string[];
    campaignFound: boolean;
    campaignEditable: boolean;
    revisionConflict: boolean;
    targetsRevision: number;
    source: CampaignTargetSourceDto | null;
  }> {
    return this.database.transaction(async client => {
      const campaignResult = await client.query<{
        session_id: string;
        status: string;
        targets_revision: string;
        target_source_group_list_id: string | null;
      }>(
        `SELECT session_id, status, targets_revision::text, target_source_group_list_id
         FROM campaigns WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [campaignId],
      );
      const campaign = campaignResult.rows[0];
      if (!campaign || campaign.status !== 'DRAFT') {
        return {
          targets: [], missingGroupIds: [], mismatchedGroupIds: [],
          campaignFound: Boolean(campaign), campaignEditable: false, revisionConflict: false,
          targetsRevision: campaign ? Number(campaign.targets_revision) : 0,
          source: null,
        };
      }
      if (Number(campaign.targets_revision) !== expectedTargetsRevision) {
        return {
          targets: [], missingGroupIds: [], mismatchedGroupIds: [],
          campaignFound: true, campaignEditable: true, revisionConflict: true,
          targetsRevision: Number(campaign.targets_revision),
          source: null,
        };
      }

      const groupRows = groupIds.length
        ? await client.query<{ id: string; session_id: string }>(
            `SELECT id, session_id FROM gateway_groups
             WHERE id = ANY($1::text[]) FOR SHARE`,
            [groupIds],
          )
        : { rows: [] as Array<{ id: string; session_id: string }> };
      const found = new Map<string, boolean>();
      for (const row of groupRows.rows) {
        found.set(row.id, (found.get(row.id) ?? false) || row.session_id === campaign.session_id);
      }
      const missingGroupIds = groupIds.filter(id => !found.has(id));
      const mismatchedGroupIds = groupIds.filter(id => found.get(id) === false);
      if (missingGroupIds.length || mismatchedGroupIds.length) {
        return {
          targets: [], missingGroupIds, mismatchedGroupIds,
          campaignFound: true, campaignEditable: true, revisionConflict: false,
          targetsRevision: Number(campaign.targets_revision),
          source: null,
        };
      }

      const currentResult = await client.query<{ group_id: string }>(
        'SELECT group_id FROM campaign_targets WHERE campaign_id = $1 ORDER BY group_id FOR UPDATE',
        [campaignId],
      );
      const current = currentResult.rows.map(row => row.group_id);
      const next = [...groupIds].sort();
      const membershipChanged = current.length !== next.length
        || current.some((id, index) => id !== next[index]);
      const changed = membershipChanged || campaign.target_source_group_list_id !== null;
      let targetsRevision = Number(campaign.targets_revision);
      if (changed) {
        if (membershipChanged) {
          await client.query('DELETE FROM campaign_targets WHERE campaign_id = $1', [campaignId]);
          if (next.length) {
            await client.query(
              `INSERT INTO campaign_targets (campaign_id, session_id, group_id)
               SELECT $1, $2, target_id FROM unnest($3::text[]) AS target_id`,
              [campaignId, campaign.session_id, next],
            );
          }
        }
        const revision = await client.query<{ targets_revision: string }>(
          `UPDATE campaigns SET targets_revision = targets_revision + 1,
             target_source_group_list_id = NULL,
             target_source_group_list_name_snapshot = NULL,
             target_source_membership_revision = NULL,
             target_source_applied_at = NULL,
             updated_at = now()
           WHERE id = $1 RETURNING targets_revision::text`,
          [campaignId],
        );
        targetsRevision = Number(revision.rows[0]!.targets_revision);
      }
      return {
        targets: await this.listTargetsWithClient(client, campaignId),
        missingGroupIds: [], mismatchedGroupIds: [], campaignFound: true, campaignEditable: true,
        revisionConflict: false, targetsRevision, source: null,
      };
    });
  }

  async applyGroupListTargets(input: {
    campaignId: string;
    groupListId: string;
    expectedTargetsRevision: number;
    expectedMembershipRevision?: number;
  }): Promise<{
    targets: CampaignTargetDto[];
    targetsRevision: number;
    source: CampaignTargetSourceDto | null;
    campaignFound: boolean;
    campaignEditable: boolean;
    targetRevisionConflict: boolean;
    sourceFound: boolean;
    sourceSessionMismatch: boolean;
    sourceSessionId?: string;
    sourceRevisionConflict: boolean;
    currentSourceRevision?: number;
  }> {
    return this.database.transaction(async client => {
      const campaignResult = await client.query<{
        session_id: string;
        status: string;
        targets_revision: string;
        target_source_group_list_id: string | null;
        target_source_membership_revision: string | null;
      }>(
        `SELECT session_id, status, targets_revision::text, target_source_group_list_id,
           target_source_membership_revision::text
         FROM campaigns WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [input.campaignId],
      );
      const campaign = campaignResult.rows[0];
      const empty = {
        targets: [] as CampaignTargetDto[], targetsRevision: campaign ? Number(campaign.targets_revision) : 0,
        source: null, campaignFound: Boolean(campaign), campaignEditable: campaign?.status === 'DRAFT',
        targetRevisionConflict: false, sourceFound: false, sourceSessionMismatch: false,
        sourceRevisionConflict: false,
      };
      if (!campaign || campaign.status !== 'DRAFT') return empty;
      if (Number(campaign.targets_revision) !== input.expectedTargetsRevision) {
        return { ...empty, targetRevisionConflict: true };
      }

      const source = await this.groupLists.lockMembershipSnapshot(client, input.groupListId);
      if (!source) return empty;
      if (source.sessionId !== campaign.session_id) {
        return {
          ...empty, sourceFound: true, sourceSessionMismatch: true, sourceSessionId: source.sessionId,
        };
      }
      if (input.expectedMembershipRevision !== undefined
        && source.membershipRevision !== input.expectedMembershipRevision) {
        return {
          ...empty,
          sourceFound: true,
          sourceRevisionConflict: true,
          currentSourceRevision: source.membershipRevision,
        };
      }

      const currentResult = await client.query<{ group_id: string }>(
        'SELECT group_id FROM campaign_targets WHERE campaign_id = $1 ORDER BY group_id FOR UPDATE',
        [input.campaignId],
      );
      const current = currentResult.rows.map(row => row.group_id);
      const membershipChanged = current.length !== source.groupIds.length
        || current.some((id, index) => id !== source.groupIds[index]);
      const provenanceChanged = campaign.target_source_group_list_id !== source.id
        || Number(campaign.target_source_membership_revision) !== source.membershipRevision;
      let targetsRevision = Number(campaign.targets_revision);
      let appliedAt = new Date();
      if (membershipChanged || provenanceChanged) {
        if (membershipChanged) {
          await client.query('DELETE FROM campaign_targets WHERE campaign_id = $1', [input.campaignId]);
          if (source.groupIds.length) {
            await client.query(
              `INSERT INTO campaign_targets (campaign_id, session_id, group_id)
               SELECT $1, $2, group_id FROM unnest($3::text[]) AS group_id`,
              [input.campaignId, campaign.session_id, source.groupIds],
            );
          }
        }
        const updated = await client.query<{
          targets_revision: string;
          target_source_applied_at: Date;
        }>(
          `UPDATE campaigns SET targets_revision = targets_revision + 1,
             target_source_group_list_id = $2,
             target_source_group_list_name_snapshot = $3,
             target_source_membership_revision = $4,
             target_source_applied_at = now(), updated_at = now()
           WHERE id = $1
           RETURNING targets_revision::text, target_source_applied_at`,
          [input.campaignId, source.id, source.name, source.membershipRevision],
        );
        targetsRevision = Number(updated.rows[0]!.targets_revision);
        appliedAt = updated.rows[0]!.target_source_applied_at;
      } else {
        const existing = await client.query<{ target_source_applied_at: Date }>(
          'SELECT target_source_applied_at FROM campaigns WHERE id = $1',
          [input.campaignId],
        );
        appliedAt = existing.rows[0]!.target_source_applied_at;
      }
      return {
        targets: await this.listTargetsWithClient(client, input.campaignId),
        targetsRevision,
        source: {
          type: 'GROUP_LIST', groupListId: source.id,
          groupListNameSnapshot: source.name,
          membershipRevision: source.membershipRevision, appliedAt,
        },
        campaignFound: true,
        campaignEditable: true,
        targetRevisionConflict: false,
        sourceFound: true,
        sourceSessionMismatch: false,
        sourceRevisionConflict: false,
      };
    });
  }

  async delete(input: {
    id: string;
    allowedSessionIds: string[];
    expectedRevision: number;
    expectedTargetsRevision: number;
  }): Promise<CampaignDeletionResult> {
    return this.database.transaction(async client => {
      const result = await client.query<{
        status: CampaignStatus;
        revision: string | number;
        targets_revision: string | number;
        deleted_at: Date | null;
      }>(
        `SELECT status, revision, targets_revision, deleted_at
         FROM campaigns
         WHERE id = $1 AND session_id = ANY($2::text[])
         FOR UPDATE`,
        [input.id, input.allowedSessionIds],
      );
      const campaign = result.rows[0];
      const empty: CampaignDeletionResult = {
        found: Boolean(campaign), alreadyDeleted: false, deleted: false,
        revisionConflict: false, stateConflict: false, runConflict: false,
      };
      if (!campaign) return empty;
      if (campaign.deleted_at) return { ...empty, alreadyDeleted: true };

      const currentRevision = Number(campaign.revision);
      const currentTargetsRevision = Number(campaign.targets_revision);
      const current = { currentRevision, currentTargetsRevision, currentStatus: campaign.status };
      if (currentRevision !== input.expectedRevision
        || currentTargetsRevision !== input.expectedTargetsRevision) {
        return { ...empty, ...current, revisionConflict: true };
      }
      if (!['DRAFT', 'ARCHIVED'].includes(campaign.status)) {
        return { ...empty, ...current, stateConflict: true };
      }

      const activeRun = await client.query(
        `SELECT id FROM campaign_runs
         WHERE campaign_id = $1
           AND status IN ('PREPARING','BLOCKED','SCHEDULED','RUNNING','PAUSED')
         ORDER BY id LIMIT 1 FOR UPDATE`,
        [input.id],
      );
      if (activeRun.rowCount) return { ...empty, ...current, runConflict: true };

      await client.query(
        `UPDATE campaigns
         SET deleted_at = now(), revision = revision + 1, updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [input.id],
      );
      return { ...empty, ...current, deleted: true };
    });
  }

  private async listTargetsWithClient(client: PoolClient, campaignId: string): Promise<CampaignTargetDto[]> {
    const result = await client.query<TargetRow>(
      `SELECT ct.group_id, g.name AS group_name, ct.enabled, g.send_capability,
         g.send_capability_reason, g.capability_checked_at, g.capability_invalidated_at,
         g.capability_revision
       FROM campaign_targets ct
       JOIN gateway_groups g ON g.session_id = ct.session_id AND g.id = ct.group_id
       WHERE ct.campaign_id = $1 ORDER BY g.name, g.id`,
      [campaignId],
    );
    return result.rows.map(mapTarget);
  }
}
