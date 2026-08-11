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
  }): Promise<CampaignDto> {
    const result = await this.database.query<CampaignRow>(
      `WITH inserted AS (
         INSERT INTO campaigns (session_id, name, payload, schedule_type, scheduled_at)
         VALUES ($1,$2,$3::jsonb,$4,$5) RETURNING *
       )
       SELECT inserted.*, 0 AS target_count FROM inserted`,
      [input.sessionId, input.name, JSON.stringify({ text: input.text }), input.scheduleType, input.scheduledAt],
    );
    return mapCampaign(result.rows[0]!);
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
           scheduled_at = $5, updated_at = now()
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

  async replaceTargets(campaignId: string, groupIds: string[]): Promise<{
    targets: CampaignTargetDto[];
    invalidGroupIds: string[];
    campaignFound: boolean;
  }> {
    return this.database.transaction(async client => {
      const campaignResult = await client.query<{ session_id: string; status: string }>(
        'SELECT session_id, status FROM campaigns WHERE id = $1 FOR UPDATE', [campaignId],
      );
      const campaign = campaignResult.rows[0];
      if (!campaign || campaign.status !== 'DRAFT') {
        return { targets: [], invalidGroupIds: [], campaignFound: Boolean(campaign) };
      }

      const validResult = groupIds.length
        ? await client.query<{ id: string }>(
            `SELECT id FROM gateway_groups
             WHERE session_id = $1 AND id = ANY($2::text[]) AND is_active = true
             FOR SHARE`,
            [campaign.session_id, groupIds],
          )
        : { rows: [] as Array<{ id: string }> };
      const valid = new Set(validResult.rows.map(row => row.id));
      const invalidGroupIds = groupIds.filter(id => !valid.has(id));
      if (invalidGroupIds.length) return { targets: [], invalidGroupIds, campaignFound: true };

      await client.query('DELETE FROM campaign_targets WHERE campaign_id = $1', [campaignId]);
      for (const groupId of groupIds) {
        await client.query(
          `INSERT INTO campaign_targets (campaign_id, session_id, group_id)
           VALUES ($1,$2,$3)`,
          [campaignId, campaign.session_id, groupId],
        );
      }
      await client.query('UPDATE campaigns SET updated_at = now() WHERE id = $1', [campaignId]);
      return { targets: await this.listTargetsWithClient(client, campaignId), invalidGroupIds: [], campaignFound: true };
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
