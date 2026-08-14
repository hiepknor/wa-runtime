import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { CampaignDto } from '../../contracts/campaigns/campaign.dto';
import type { CampaignTargetDto } from '../../contracts/campaigns/campaign-target.dto';
import type { CampaignScheduleType } from '../../contracts/campaigns/create-campaign.dto';
import { DatabaseService } from '../../core/database/database.service';
import type { GroupSendCapabilityStatus } from '../gateway/group-capability';

interface CampaignRow {
  id: string;
  session_id: string;
  name: string;
  payload: { text: string };
  schedule_type: CampaignScheduleType;
  scheduled_at: Date | null;
  status: string;
  target_count: string | number;
  revision: string | number;
  targets_revision: string | number;
  create_request_hash?: string | null;
  created_at: Date;
  updated_at: Date;
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

@Injectable()
export class CampaignRepository {
  constructor(private readonly database: DatabaseService) {}

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
  }): Promise<{ campaign: CampaignDto; created: boolean; requestHash: string }> {
    const result = await this.database.query<CampaignRow>(
      `WITH inserted AS (
         INSERT INTO campaigns
           (session_id, name, payload, schedule_type, scheduled_at, create_idempotency_key, create_request_hash)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6::uuid,$7)
         ON CONFLICT (create_idempotency_key) WHERE create_idempotency_key IS NOT NULL DO NOTHING
         RETURNING *
       ), selected AS (
         SELECT inserted.*, true AS created FROM inserted
         UNION ALL
         SELECT existing.*, false AS created FROM campaigns existing
         WHERE existing.create_idempotency_key = $6::uuid AND NOT EXISTS (SELECT 1 FROM inserted)
       )
       SELECT selected.*, 0 AS target_count FROM selected LIMIT 1`,
      [input.sessionId, input.name, JSON.stringify({ text: input.text }), input.scheduleType, input.scheduledAt,
        input.idempotencyKey, input.requestHash],
    );
    const row = result.rows[0]! as CampaignRow & { created: boolean };
    return { campaign: mapCampaign(row), created: row.created, requestHash: row.create_request_hash! };
  }

  async find(id: string): Promise<CampaignDto | null> {
    const result = await this.database.query<CampaignRow>(`${campaignSelect} WHERE c.id = $1`, [id]);
    return result.rows[0] ? mapCampaign(result.rows[0]) : null;
  }

  async list(input: { allowedSessionIds: string[]; sessionId?: string; limit: number; offset: number }) {
    const sessionIds = input.sessionId ? [input.sessionId] : input.allowedSessionIds;
    const [rows, count] = await Promise.all([
      this.database.query<CampaignRow>(
        `${campaignSelect} WHERE c.session_id = ANY($1::text[])
         ORDER BY c.updated_at DESC, c.id LIMIT $2 OFFSET $3`,
        [sessionIds, input.limit, input.offset],
      ),
      this.database.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM campaigns WHERE session_id = ANY($1::text[])',
        [sessionIds],
      ),
    ]);
    return { data: rows.rows.map(mapCampaign), total: Number(count.rows[0]?.count ?? 0) };
  }

  async update(id: string, input: {
    name: string;
    text: string;
    scheduleType: CampaignScheduleType;
    scheduledAt: Date | null;
  }): Promise<CampaignDto | null> {
    const result = await this.database.query<CampaignRow>(
      `WITH updated AS (
         UPDATE campaigns SET name = $2, payload = $3::jsonb, schedule_type = $4,
           scheduled_at = $5,
           revision = revision + CASE WHEN (name, payload, schedule_type, scheduled_at)
             IS DISTINCT FROM ($2, $3::jsonb, $4::campaign_schedule_type, $5::timestamptz) THEN 1 ELSE 0 END,
           updated_at = CASE WHEN (name, payload, schedule_type, scheduled_at)
             IS DISTINCT FROM ($2, $3::jsonb, $4::campaign_schedule_type, $5::timestamptz) THEN now() ELSE updated_at END
         WHERE id = $1 AND status = 'DRAFT' RETURNING *
       )
       SELECT updated.*,
         (SELECT count(*) FROM campaign_targets WHERE campaign_id = updated.id AND enabled) AS target_count
       FROM updated`,
      [id, input.name, JSON.stringify({ text: input.text }), input.scheduleType, input.scheduledAt],
    );
    return result.rows[0] ? mapCampaign(result.rows[0]) : null;
  }

  async listTargets(campaignId: string): Promise<CampaignTargetDto[]> {
    const result = await this.database.query<TargetRow>(
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

  async getPreflightSnapshot(campaignId: string): Promise<{
    campaign: CampaignDto;
    targets: CampaignTargetDto[];
  } | null> {
    return this.database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const campaignResult = await client.query<CampaignRow>(`${campaignSelect} WHERE c.id = $1`, [campaignId]);
      const row = campaignResult.rows[0];
      if (!row) return null;
      return {
        campaign: mapCampaign(row),
        targets: await this.listTargetsWithClient(client, campaignId),
      };
    });
  }

  async replaceTargets(campaignId: string, groupIds: string[]): Promise<{
    targets: CampaignTargetDto[];
    missingGroupIds: string[];
    mismatchedGroupIds: string[];
    campaignFound: boolean;
    campaignEditable: boolean;
  }> {
    return this.database.transaction(async client => {
      const campaignResult = await client.query<{ session_id: string; status: string }>(
        'SELECT session_id, status FROM campaigns WHERE id = $1 FOR UPDATE', [campaignId],
      );
      const campaign = campaignResult.rows[0];
      if (!campaign || campaign.status !== 'DRAFT') {
        return {
          targets: [], missingGroupIds: [], mismatchedGroupIds: [],
          campaignFound: Boolean(campaign), campaignEditable: false,
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
          campaignFound: true, campaignEditable: true,
        };
      }

      const currentResult = await client.query<{ group_id: string }>(
        'SELECT group_id FROM campaign_targets WHERE campaign_id = $1 ORDER BY group_id FOR UPDATE',
        [campaignId],
      );
      const current = currentResult.rows.map(row => row.group_id);
      const next = [...groupIds].sort();
      const changed = current.length !== next.length || current.some((id, index) => id !== next[index]);
      if (changed) {
        await client.query('DELETE FROM campaign_targets WHERE campaign_id = $1', [campaignId]);
        if (next.length) {
          await client.query(
            `INSERT INTO campaign_targets (campaign_id, session_id, group_id)
             SELECT $1, $2, target_id FROM unnest($3::text[]) AS target_id`,
            [campaignId, campaign.session_id, next],
          );
        }
        await client.query(
          'UPDATE campaigns SET targets_revision = targets_revision + 1, updated_at = now() WHERE id = $1',
          [campaignId],
        );
      }
      return {
        targets: await this.listTargetsWithClient(client, campaignId),
        missingGroupIds: [], mismatchedGroupIds: [], campaignFound: true, campaignEditable: true,
      };
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
