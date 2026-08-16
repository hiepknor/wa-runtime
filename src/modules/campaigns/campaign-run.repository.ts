import { Injectable } from '@nestjs/common';
import type { CampaignExecutionMode, CampaignPreflightDto } from '../../contracts/campaigns/campaign-preflight.dto';
import type { CampaignRunDto } from '../../contracts/campaigns/campaign-run.dto';
import type { CampaignScheduleType } from '../../contracts/campaigns/create-campaign.dto';
import type { CampaignTargetDto } from '../../contracts/campaigns/campaign-target.dto';
import { DatabaseService } from '../../core/database/database.service';
import { MessageJobRepository } from '../messages/message-job.repository';
import { CampaignDeliveryRepository } from './campaign-delivery.repository';
import {
  CampaignResumeResult,
  CampaignRunLifecycleRepository,
} from './campaign-run-lifecycle.repository';
import {
  CampaignRunRow,
  PreflightTargetRow,
  campaignRunSelect as runSelect,
  capabilitySnapshotChanged,
  mapCampaignRun as mapRun,
  mapPreflightTarget,
} from './campaign-run.persistence';

export interface ClaimedCampaignPreparation {
  leaseToken: string;
  attemptNumber: number;
}

export type CampaignPreparationResult = 'PREPARING' | 'FAILED' | 'LOST_OWNERSHIP';
export type CampaignPreflightApplyResult = 'APPLIED' | 'STALE_INPUT' | 'LOST_OWNERSHIP';
export type { CampaignResumeResult } from './campaign-run-lifecycle.repository';

export interface CampaignLifecycleDrift {
  draftWithLive: number;
  activeWithoutNonTerminalLive: number;
  pausedWithoutPausedOrBlockedLive: number;
  archivedWithNonTerminalLive: number;
  multipleLive: number;
}


@Injectable()
export class CampaignRunRepository {
  private readonly deliveries: CampaignDeliveryRepository;
  private readonly lifecycle: CampaignRunLifecycleRepository;

  constructor(
    private readonly database: DatabaseService,
    messageJobs: MessageJobRepository,
  ) {
    this.deliveries = new CampaignDeliveryRepository(database, messageJobs);
    this.lifecycle = new CampaignRunLifecycleRepository(database);
  }

  async create(input: {
    campaignId: string;
    idempotencyKey: string;
    executionMode: CampaignExecutionMode;
    expectedCampaignRevision?: number;
    expectedTargetsRevision?: number;
  }): Promise<{
    run: CampaignRunDto | null;
    created: boolean;
    campaignFound: boolean;
    idempotencyConflict: boolean;
    campaignNotLaunchable: boolean;
    revisionConflict: boolean;
    scheduleExpired: boolean;
    currentCampaignRevision?: number;
    currentTargetsRevision?: number;
  }> {
    return this.database.transaction(async client => {
      const campaignResult = await client.query<{
        id: string;
        session_id: string;
        payload: { text: string };
        schedule_type: CampaignScheduleType;
        scheduled_at: Date | null;
        status: string;
        revision: string | number;
        targets_revision: string | number;
        target_source_group_list_id: string | null;
        target_source_group_list_name_snapshot: string | null;
        target_source_membership_revision: string | number | null;
        target_source_applied_at: Date | null;
      }>(`SELECT id, session_id, payload, schedule_type, scheduled_at, status, revision, targets_revision
             , target_source_group_list_id, target_source_group_list_name_snapshot,
               target_source_membership_revision, target_source_applied_at
           FROM campaigns WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [input.campaignId]);
      const campaign = campaignResult.rows[0];
      const empty = {
        run: null, created: false, campaignFound: Boolean(campaign), idempotencyConflict: false,
        campaignNotLaunchable: false, revisionConflict: false, scheduleExpired: false,
      };
      if (!campaign) return empty;

      const existing = await client.query<CampaignRunRow>(
        `${runSelect} WHERE cr.campaign_id = $1 AND cr.idempotency_key = $2`,
        [campaign.id, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const run = existing.rows[0];
        return {
          ...empty,
          run: mapRun(run),
          campaignFound: true,
          idempotencyConflict: run.execution_mode !== input.executionMode,
        };
      }

      const existingLive = await client.query(
        `SELECT 1 FROM campaign_runs
         WHERE campaign_id = $1 AND execution_mode = 'LIVE'
         LIMIT 1`,
        [campaign.id],
      );
      if (existingLive.rowCount) {
        return { ...empty, campaignFound: true, campaignNotLaunchable: true };
      }

      const currentCampaignRevision = Number(campaign.revision);
      const currentTargetsRevision = Number(campaign.targets_revision);
      if ((input.expectedCampaignRevision !== undefined
          && input.expectedCampaignRevision !== currentCampaignRevision)
        || (input.expectedTargetsRevision !== undefined
          && input.expectedTargetsRevision !== currentTargetsRevision)) {
        return {
          ...empty, campaignFound: true, revisionConflict: true,
          currentCampaignRevision, currentTargetsRevision,
        };
      }
      if (campaign.status !== 'DRAFT') {
        return { ...empty, campaignFound: true, campaignNotLaunchable: true };
      }
      if (input.executionMode === 'LIVE' && campaign.schedule_type === 'ONCE'
        && campaign.scheduled_at && campaign.scheduled_at <= new Date()) {
        return { ...empty, campaignFound: true, scheduleExpired: true };
      }

      const scheduledAt = campaign.schedule_type === 'ONCE' && campaign.scheduled_at
        ? campaign.scheduled_at
        : new Date();
      const inserted = await client.query<{ id: string }>(
         `INSERT INTO campaign_runs
           (campaign_id, session_id, idempotency_key, execution_mode, payload_snapshot, scheduled_at,
            campaign_revision, targets_revision, target_source_group_list_id,
            target_source_group_list_name_snapshot, target_source_membership_revision,
            target_source_applied_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT DO NOTHING RETURNING id`,
        [campaign.id, campaign.session_id, input.idempotencyKey, input.executionMode,
          JSON.stringify(campaign.payload), scheduledAt, campaign.revision, campaign.targets_revision,
          campaign.target_source_group_list_id, campaign.target_source_group_list_name_snapshot,
          campaign.target_source_membership_revision,
          campaign.target_source_applied_at],
      );
      if (!inserted.rows[0]) {
        const replay = await client.query<CampaignRunRow>(
          `${runSelect} WHERE cr.campaign_id = $1 AND cr.idempotency_key = $2`,
          [campaign.id, input.idempotencyKey],
        );
        const run = replay.rows[0];
        if (!run) {
          return { ...empty, campaignFound: true, campaignNotLaunchable: true };
        }
        return {
          ...empty,
          run: mapRun(run),
          created: false,
          campaignFound: true,
          idempotencyConflict: run.execution_mode !== input.executionMode,
        };
      }

      const runId = inserted.rows[0].id;
      await client.query(
        `INSERT INTO campaign_run_targets
           (run_id, session_id, group_id, group_name, capability, capability_reason,
            capability_revision, capability_checked_at)
         SELECT $1, ct.session_id, ct.group_id, g.name, g.send_capability,
           g.send_capability_reason, g.capability_revision, g.capability_checked_at
         FROM campaign_targets ct
         JOIN gateway_groups g ON g.session_id = ct.session_id AND g.id = ct.group_id
         WHERE ct.campaign_id = $2 AND ct.enabled`,
        [runId, campaign.id],
      );
      if (input.executionMode === 'LIVE') {
        await client.query(
          `UPDATE campaigns SET status = 'ACTIVE', updated_at = now()
           WHERE id = $1 AND status = 'DRAFT'`,
          [campaign.id],
        );
      }
      const result = await client.query<CampaignRunRow>(`${runSelect} WHERE cr.id = $1`, [runId]);
      return {
        ...empty, run: mapRun(result.rows[0]!), created: true, campaignFound: true,
      };
    });
  }

  async find(id: string): Promise<CampaignRunDto | null> {
    const result = await this.database.query<CampaignRunRow>(`${runSelect} WHERE cr.id = $1`, [id]);
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async listByCampaign(campaignId: string, limit: number, offset: number) {
    return this.database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const rows = await client.query<CampaignRunRow>(
        `${runSelect} WHERE cr.campaign_id = $1 ORDER BY cr.created_at DESC, cr.id ASC LIMIT $2 OFFSET $3`,
        [campaignId, limit, offset],
      );
      const count = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM campaign_runs WHERE campaign_id = $1', [campaignId],
      );
      return { data: rows.rows.map(mapRun), total: Number(count.rows[0]?.count ?? 0) };
    });
  }

  async listPreparing(limit: number): Promise<Array<{ id: string }>> {
    const result = await this.database.query<{ id: string }>(
      `SELECT id FROM campaign_runs
       WHERE status = 'PREPARING' AND preparation_next_attempt_at <= now()
         AND preparation_attempt_count < 3
         AND (preparation_lease_token IS NULL OR preparation_lease_expires_at < now())
       ORDER BY preparation_next_attempt_at, created_at LIMIT $1`, [limit],
    );
    return result.rows;
  }

  async auditLifecycle(): Promise<CampaignLifecycleDrift> {
    const result = await this.database.query<{
      draft_with_live: string;
      active_without_non_terminal_live: string;
      paused_without_paused_or_blocked_live: string;
      archived_with_non_terminal_live: string;
      multiple_live: string;
    }>(
      `WITH live AS (
         SELECT campaign_id, count(*) AS live_count,
           bool_or(status IN ('PREPARING','BLOCKED','SCHEDULED','RUNNING','PAUSED')) AS has_non_terminal,
           bool_or(status IN ('PAUSED','BLOCKED')) AS has_paused_or_blocked
         FROM campaign_runs WHERE execution_mode = 'LIVE' GROUP BY campaign_id
       )
       SELECT
         count(*) FILTER (WHERE c.status = 'DRAFT' AND coalesce(l.live_count, 0) > 0)::text
           AS draft_with_live,
         count(*) FILTER (WHERE c.status = 'ACTIVE' AND NOT coalesce(l.has_non_terminal, false))::text
           AS active_without_non_terminal_live,
         count(*) FILTER (WHERE c.status = 'PAUSED'
           AND NOT coalesce(l.has_paused_or_blocked, false))::text
           AS paused_without_paused_or_blocked_live,
         count(*) FILTER (WHERE c.status = 'ARCHIVED' AND coalesce(l.has_non_terminal, false))::text
           AS archived_with_non_terminal_live,
         count(*) FILTER (WHERE coalesce(l.live_count, 0) > 1)::text AS multiple_live
       FROM campaigns c LEFT JOIN live l ON l.campaign_id = c.id`,
    );
    const row = result.rows[0]!;
    return {
      draftWithLive: Number(row.draft_with_live),
      activeWithoutNonTerminalLive: Number(row.active_without_non_terminal_live),
      pausedWithoutPausedOrBlockedLive: Number(row.paused_without_paused_or_blocked_live),
      archivedWithNonTerminalLive: Number(row.archived_with_non_terminal_live),
      multipleLive: Number(row.multiple_live),
    };
  }

  async claimPreparation(runId: string): Promise<ClaimedCampaignPreparation | null> {
    const result = await this.database.query<{ preparation_lease_token: string; preparation_attempt_count: number }>(
      `UPDATE campaign_runs SET preparation_attempt_count = preparation_attempt_count + 1,
         preparation_lease_token = gen_random_uuid(),
         preparation_lease_expires_at = now() + interval '2 minutes',
         preparation_error = NULL, updated_at = now()
       WHERE id = $1 AND status = 'PREPARING' AND preparation_next_attempt_at <= now()
         AND preparation_attempt_count < 3
         AND (preparation_lease_token IS NULL OR preparation_lease_expires_at < now())
       RETURNING preparation_lease_token, preparation_attempt_count`,
      [runId],
    );
    const row = result.rows[0];
    return row ? { leaseToken: row.preparation_lease_token, attemptNumber: row.preparation_attempt_count } : null;
  }

  async recoverExpiredPreparations(): Promise<number> {
    return this.database.transaction(async client => {
      const result = await client.query<{ campaign_id: string; execution_mode: CampaignExecutionMode; status: string }>(
        `UPDATE campaign_runs SET
         status = CASE WHEN preparation_attempt_count >= 3 THEN 'FAILED'::campaign_run_status
           ELSE 'PREPARING'::campaign_run_status END,
         status_reason = CASE WHEN preparation_attempt_count >= 3 THEN 'PREPARATION_FAILED' ELSE status_reason END,
         preparation_next_attempt_at = now(), preparation_lease_token = NULL,
         preparation_lease_expires_at = NULL,
         preparation_error = 'Recovered expired campaign preparation lease',
         completed_at = CASE WHEN preparation_attempt_count >= 3 THEN now() ELSE completed_at END,
         updated_at = now()
       WHERE status = 'PREPARING' AND (
         (preparation_lease_token IS NOT NULL AND preparation_lease_expires_at < now())
         OR (preparation_lease_token IS NULL AND preparation_attempt_count >= 3)
       ) RETURNING campaign_id, execution_mode, status`,
      );
      const failedLiveCampaignIds = result.rows
        .filter(row => row.execution_mode === 'LIVE' && row.status === 'FAILED')
        .map(row => row.campaign_id);
      if (failedLiveCampaignIds.length) {
        await client.query(
          `UPDATE campaigns SET status = 'ARCHIVED', updated_at = now()
           WHERE id = ANY($1::uuid[]) AND status IN ('ACTIVE','PAUSED')`,
          [failedLiveCampaignIds],
        );
      }
      return result.rowCount ?? 0;
    });
  }

  async getPreflightContext(runId: string): Promise<{
    run: CampaignRunDto;
    targets: CampaignTargetDto[];
    campaignRevision: number;
    targetsRevision: number;
  } | null> {
    return this.database.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const runResult = await client.query<CampaignRunRow>(`${runSelect} WHERE cr.id = $1`, [runId]);
      const row = runResult.rows[0];
      if (!row) return null;
      const result = await client.query<PreflightTargetRow>(
        `SELECT crt.group_id, crt.group_name, g.send_capability, g.send_capability_reason,
           g.capability_checked_at, g.capability_invalidated_at, g.capability_revision
         FROM campaign_run_targets crt
         JOIN gateway_groups g ON g.session_id = crt.session_id AND g.id = crt.group_id
         WHERE crt.run_id = $1 ORDER BY crt.group_name, crt.group_id`,
        [runId],
      );
      return {
        run: mapRun(row),
        targets: result.rows.map(mapPreflightTarget),
        campaignRevision: Number(row.campaign_revision),
        targetsRevision: Number(row.targets_revision),
      };
    });
  }

  async applyPreflight(
    runId: string,
    leaseToken: string,
    report: CampaignPreflightDto,
    observedTargets: CampaignTargetDto[],
  ): Promise<CampaignPreflightApplyResult> {
    return this.database.transaction(async client => {
      const locked = await client.query<{ status: string; scheduled_at: Date }>(
         `SELECT status, scheduled_at FROM campaign_runs
         WHERE id = $1 AND status = 'PREPARING' AND preparation_lease_token = $2
           AND preparation_lease_expires_at > now() FOR UPDATE`,
        [runId, leaseToken],
      );
      const run = locked.rows[0];
      if (!run) return 'LOST_OWNERSHIP';
      if (await capabilitySnapshotChanged(client, runId, observedTargets)) {
        await client.query(
          `UPDATE campaign_runs SET preparation_lease_token = NULL,
             preparation_lease_expires_at = NULL, preparation_next_attempt_at = now(),
             preparation_attempt_count = GREATEST(0, preparation_attempt_count - 1), updated_at = now()
           WHERE id = $1 AND status = 'PREPARING' AND preparation_lease_token = $2`,
          [runId, leaseToken],
        );
        return 'STALE_INPUT';
      }
      if (report.status === 'BLOCK') {
        await client.query(
          `UPDATE campaign_runs SET status = 'BLOCKED', status_reason = 'PREFLIGHT_BLOCKED', preflight_status = $2,
             preflight_policy_version = $3, preflight_report = $4::jsonb,
             preparation_lease_token = NULL, preparation_lease_expires_at = NULL, updated_at = now()
           WHERE id = $1`,
          [runId, report.status, report.policyVersion, JSON.stringify(report)],
        );
        return 'APPLIED';
      }

      await client.query(
        `UPDATE campaign_run_targets crt SET
           capability = g.send_capability, capability_reason = g.send_capability_reason,
           capability_revision = g.capability_revision, capability_checked_at = g.capability_checked_at
         FROM gateway_groups g
         WHERE crt.run_id = $1 AND g.session_id = crt.session_id AND g.id = crt.group_id`,
        [runId],
      );
      await client.query(
        `INSERT INTO campaign_deliveries (run_id, group_id)
         SELECT run_id, group_id FROM campaign_run_targets WHERE run_id = $1
         ON CONFLICT (run_id, group_id) DO NOTHING`,
        [runId],
      );
      const startsNow = run.scheduled_at <= new Date();
      await client.query(
        `UPDATE campaign_runs SET status = $2::campaign_run_status, status_reason = NULL,
           preflight_status = $3, preflight_policy_version = $4, preflight_report = $5::jsonb,
           started_at = CASE WHEN $2::campaign_run_status = 'RUNNING' THEN now() ELSE NULL END,
           preparation_lease_token = NULL, preparation_lease_expires_at = NULL,
           updated_at = now() WHERE id = $1`,
        [runId, startsNow ? 'RUNNING' : 'SCHEDULED', report.status,
          report.policyVersion, JSON.stringify(report)],
      );
      return 'APPLIED';
    });
  }

  async failPreparationAttempt(
    runId: string,
    leaseToken: string,
    error: string,
  ): Promise<CampaignPreparationResult> {
    return this.database.transaction(async client => {
      const result = await client.query<{
        status: 'PREPARING' | 'FAILED';
        campaign_id: string;
        execution_mode: CampaignExecutionMode;
      }>(
        `UPDATE campaign_runs SET
         status = CASE WHEN preparation_attempt_count >= 3 THEN 'FAILED'::campaign_run_status
           ELSE 'PREPARING'::campaign_run_status END,
         status_reason = CASE WHEN preparation_attempt_count >= 3 THEN 'PREPARATION_FAILED' ELSE status_reason END,
         preparation_error = $3,
         preparation_next_attempt_at = CASE WHEN preparation_attempt_count >= 3 THEN preparation_next_attempt_at
           ELSE now() + LEAST(300, 5 * power(2, preparation_attempt_count - 1)) * interval '1 second' END,
         preparation_lease_token = NULL, preparation_lease_expires_at = NULL,
         completed_at = CASE WHEN preparation_attempt_count >= 3 THEN now() ELSE completed_at END,
         updated_at = now()
       WHERE id = $1 AND status = 'PREPARING' AND preparation_lease_token = $2
         AND preparation_lease_expires_at > now()
       RETURNING status, campaign_id, execution_mode`,
        [runId, leaseToken, error],
      );
      const row = result.rows[0];
      if (row?.status === 'FAILED' && row.execution_mode === 'LIVE') {
        await client.query(
          `UPDATE campaigns SET status = 'ARCHIVED', updated_at = now()
           WHERE id = $1 AND status IN ('ACTIVE','PAUSED')`,
          [row.campaign_id],
        );
      }
      return row?.status ?? 'LOST_OWNERSHIP';
    });
  }

  async activateDueRuns(): Promise<number> {
    return this.lifecycle.activateDue();
  }

  async reconcileDeliveries(): Promise<number> {
    return this.deliveries.reconcile();
  }

  async finalizeRuns(limit: number): Promise<number> {
    return this.lifecycle.finalize(limit);
  }

  async pause(id: string): Promise<CampaignRunDto | null> {
    return this.lifecycle.pause(id);
  }

  async recordBlockedResume(id: string, report: CampaignPreflightDto): Promise<void> {
    return this.lifecycle.recordBlockedResume(id, report);
  }

  async resume(
    id: string,
    report: CampaignPreflightDto,
    observedTargets: CampaignTargetDto[],
  ): Promise<CampaignResumeResult> {
    return this.lifecycle.resume(id, report, observedTargets);
  }

  async cancel(id: string): Promise<CampaignRunDto | null> {
    return this.lifecycle.cancel(id);
  }

  async listRunningIds(limit: number): Promise<string[]> {
    return this.lifecycle.listRunningIds(limit);
  }

  async materializePending(runId: string, maxBuffered: number): Promise<number> {
    return this.deliveries.materializePending(runId, maxBuffered);
  }

  async listDeliveries(runId: string, limit: number, offset: number) {
    return this.deliveries.list(runId, limit, offset);
  }
}
