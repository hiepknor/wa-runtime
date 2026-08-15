import type { CampaignExecutionMode, CampaignPreflightDto } from '../../contracts/campaigns/campaign-preflight.dto';
import type { CampaignRunDto } from '../../contracts/campaigns/campaign-run.dto';
import type { CampaignTargetDto } from '../../contracts/campaigns/campaign-target.dto';
import { DatabaseService } from '../../core/database/database.service';
import {
  CampaignRunRow,
  campaignRunSelect,
  capabilitySnapshotChanged,
  mapCampaignRun,
} from './campaign-run.persistence';

export type CampaignResumeResult = CampaignRunDto | 'STALE_INPUT' | null;

export class CampaignRunLifecycleRepository {
  constructor(private readonly database: DatabaseService) {}

  async activateDue(): Promise<number> {
    const result = await this.database.query(
      `UPDATE campaign_runs SET status = 'RUNNING', status_reason = NULL,
         started_at = COALESCE(started_at, now()), updated_at = now()
       WHERE status = 'SCHEDULED' AND scheduled_at <= now()`,
    );
    return result.rowCount ?? 0;
  }

  async finalize(limit: number): Promise<number> {
    return this.database.transaction(async client => {
      const result = await client.query<{ campaign_id: string; execution_mode: CampaignExecutionMode }>(
        `WITH finalizable AS (
         SELECT cr.id,
           bool_or(cd.status IN ('FAILED','UNKNOWN','BLOCKED_CAPABILITY_CHANGED','CANCELLED')) AS has_failure
         FROM campaign_runs cr
         JOIN campaign_deliveries cd ON cd.run_id = cr.id
         WHERE cr.status = 'RUNNING'
         GROUP BY cr.id
         HAVING bool_and(cd.status NOT IN ('PENDING','MATERIALIZED','PROCESSING'))
         ORDER BY min(cr.started_at), cr.id
         LIMIT $1
       )
       UPDATE campaign_runs cr SET
         status = CASE WHEN f.has_failure THEN 'PARTIAL_FAILED'::campaign_run_status
                       ELSE 'COMPLETED'::campaign_run_status END,
         status_reason = CASE WHEN f.has_failure THEN 'ONE_OR_MORE_DELIVERIES_FAILED' ELSE NULL END,
         completed_at = now(), updated_at = now()
       FROM finalizable f WHERE cr.id = f.id
       RETURNING cr.campaign_id, cr.execution_mode`,
        [limit],
      );
      const liveCampaignIds = result.rows
        .filter(row => row.execution_mode === 'LIVE')
        .map(row => row.campaign_id);
      if (liveCampaignIds.length) {
        await client.query(
          `UPDATE campaigns SET status = 'ARCHIVED', updated_at = now()
           WHERE id = ANY($1::uuid[]) AND status IN ('ACTIVE','PAUSED')`,
          [liveCampaignIds],
        );
      }
      return result.rowCount ?? 0;
    });
  }

  async pause(id: string): Promise<CampaignRunDto | null> {
    return this.database.transaction(async client => {
      const updated = await client.query<{ campaign_id: string; execution_mode: CampaignExecutionMode }>(
        `UPDATE campaign_runs SET status = 'PAUSED', status_reason = 'MANUAL_PAUSE', updated_at = now()
         WHERE id = $1 AND status IN ('SCHEDULED','RUNNING')
         RETURNING campaign_id, execution_mode`, [id],
      );
      const transition = updated.rows[0];
      if (!transition) return null;
      if (transition.execution_mode === 'LIVE') {
        await client.query(
          `UPDATE campaigns SET status = 'PAUSED', updated_at = now()
           WHERE id = $1 AND status = 'ACTIVE'`,
          [transition.campaign_id],
        );
      }
      const result = await client.query<CampaignRunRow>(`${campaignRunSelect} WHERE cr.id = $1`, [id]);
      return mapCampaignRun(result.rows[0]!);
    });
  }

  async recordBlockedResume(id: string, report: CampaignPreflightDto): Promise<void> {
    await this.database.query(
      `UPDATE campaign_runs SET status = 'BLOCKED', status_reason = 'PREFLIGHT_BLOCKED', preflight_status = $2,
         preflight_policy_version = $3, preflight_report = $4::jsonb, updated_at = now()
       WHERE id = $1 AND status IN ('PAUSED','BLOCKED')`,
      [id, report.status, report.policyVersion, JSON.stringify(report)],
    );
  }

  async resume(
    id: string,
    report: CampaignPreflightDto,
    observedTargets: CampaignTargetDto[],
  ): Promise<CampaignResumeResult> {
    return this.database.transaction(async client => {
      const locked = await client.query<{
        status: string;
        scheduled_at: Date;
        campaign_id: string;
        execution_mode: CampaignExecutionMode;
      }>(
        `SELECT status, scheduled_at, campaign_id, execution_mode
         FROM campaign_runs WHERE id = $1 FOR UPDATE`, [id],
      );
      const run = locked.rows[0];
      if (!run || !['PAUSED', 'BLOCKED'].includes(run.status)) return null;
      if (await capabilitySnapshotChanged(client, id, observedTargets)) return 'STALE_INPUT';
      await client.query(
        `UPDATE campaign_run_targets crt SET
           capability = g.send_capability, capability_reason = g.send_capability_reason,
           capability_revision = g.capability_revision, capability_checked_at = g.capability_checked_at
         FROM gateway_groups g
         WHERE crt.run_id = $1 AND g.session_id = crt.session_id AND g.id = crt.group_id
           AND NOT EXISTS (
             SELECT 1 FROM campaign_deliveries cd WHERE cd.run_id = crt.run_id
               AND cd.group_id = crt.group_id AND cd.status <> 'PENDING'
           )`,
        [id],
      );
      await client.query(
        `INSERT INTO campaign_deliveries (run_id, group_id)
         SELECT run_id, group_id FROM campaign_run_targets WHERE run_id = $1
         ON CONFLICT (run_id, group_id) DO NOTHING`, [id],
      );
      const status = run.scheduled_at > new Date() ? 'SCHEDULED' : 'RUNNING';
      await client.query(
        `UPDATE campaign_runs SET status = $2::campaign_run_status, status_reason = NULL, preflight_status = $3,
           preflight_policy_version = $4, preflight_report = $5::jsonb,
           started_at = CASE WHEN $2::campaign_run_status = 'RUNNING' THEN COALESCE(started_at, now()) ELSE started_at END,
           completed_at = NULL, updated_at = now() WHERE id = $1`,
        [id, status, report.status, report.policyVersion, JSON.stringify(report)],
      );
      if (run.execution_mode === 'LIVE') {
        await client.query(
          `UPDATE campaigns SET status = 'ACTIVE', updated_at = now()
           WHERE id = $1 AND status = 'PAUSED'`,
          [run.campaign_id],
        );
      }
      const result = await client.query<CampaignRunRow>(`${campaignRunSelect} WHERE cr.id = $1`, [id]);
      return mapCampaignRun(result.rows[0]!);
    });
  }

  async cancel(id: string): Promise<CampaignRunDto | null> {
    return this.database.transaction(async client => {
      const locked = await client.query<{
        status: string;
        campaign_id: string;
        execution_mode: CampaignExecutionMode;
      }>(
        `SELECT status, campaign_id, execution_mode FROM campaign_runs WHERE id = $1 FOR UPDATE`, [id],
      );
      const run = locked.rows[0];
      if (!run || !['PREPARING', 'BLOCKED', 'SCHEDULED', 'RUNNING', 'PAUSED'].includes(run.status)) return null;
      await client.query(
        `INSERT INTO campaign_deliveries (run_id, group_id)
         SELECT run_id, group_id FROM campaign_run_targets WHERE run_id = $1
         ON CONFLICT (run_id, group_id) DO NOTHING`, [id],
      );
      await client.query(
        `UPDATE message_jobs SET status = 'CANCELLED', updated_at = now()
         WHERE id IN (SELECT message_job_id FROM campaign_deliveries WHERE run_id = $1)
           AND status IN ('SCHEDULED','QUEUED')`, [id],
      );
      await client.query(
        `UPDATE campaign_deliveries cd SET status = 'CANCELLED',
           failure_reason = 'Campaign run cancelled', updated_at = now()
         WHERE run_id = $1 AND (
           status = 'PENDING' OR EXISTS (
             SELECT 1 FROM message_jobs mj WHERE mj.id = cd.message_job_id AND mj.status = 'CANCELLED'
           )
         )`, [id],
      );
      await client.query(
        `UPDATE campaign_runs SET status = 'CANCELLED', status_reason = 'CANCELLED_BY_OPERATOR',
           completed_at = now(), updated_at = now() WHERE id = $1`, [id],
      );
      if (run.execution_mode === 'LIVE') {
        await client.query(
          `UPDATE campaigns SET status = 'ARCHIVED', updated_at = now()
           WHERE id = $1 AND status IN ('ACTIVE','PAUSED')`,
          [run.campaign_id],
        );
      }
      const result = await client.query<CampaignRunRow>(`${campaignRunSelect} WHERE cr.id = $1`, [id]);
      return mapCampaignRun(result.rows[0]!);
    });
  }

  async listRunningIds(limit: number): Promise<string[]> {
    const result = await this.database.query<{ id: string }>(
      `SELECT id FROM campaign_runs WHERE status = 'RUNNING' ORDER BY started_at, id LIMIT $1`, [limit],
    );
    return result.rows.map(row => row.id);
  }
}
