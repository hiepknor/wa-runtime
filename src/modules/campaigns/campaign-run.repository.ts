import { Injectable } from '@nestjs/common';
import type { CampaignDeliveryDto } from '../../contracts/campaigns/campaign-delivery.dto';
import type { CampaignExecutionMode, CampaignPreflightDto } from '../../contracts/campaigns/campaign-preflight.dto';
import type { CampaignRunDto, CampaignRunProgressDto } from '../../contracts/campaigns/campaign-run.dto';
import type { CampaignScheduleType } from '../../contracts/campaigns/create-campaign.dto';
import type { CampaignTargetDto } from '../../contracts/campaigns/campaign-target.dto';
import { DatabaseService } from '../../core/database/database.service';
import type { GroupSendCapabilityStatus } from '../gateway/group-capability';
import { MessageJobRepository } from '../messages/message-job.repository';
import { messageRequestHash } from '../messages/message-idempotency';

interface CampaignRunRow {
  id: string;
  campaign_id: string;
  session_id: string;
  idempotency_key: string;
  execution_mode: CampaignExecutionMode;
  status: string;
  status_reason: string | null;
  payload_snapshot: { text: string };
  preflight_report: CampaignPreflightDto | null;
  scheduled_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  target_count: string | number;
  delivery_counts: Record<string, number>;
}

interface DeliveryRow {
  id: string;
  run_id: string;
  group_id: string;
  group_name: string;
  message_job_id: string | null;
  status: string;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ClaimedCampaignPreparation {
  leaseToken: string;
  attemptNumber: number;
}

export type CampaignPreparationResult = 'PREPARING' | 'FAILED' | 'LOST_OWNERSHIP';

interface PreflightTargetRow {
  group_id: string;
  group_name: string;
  send_capability: GroupSendCapabilityStatus;
  send_capability_reason: string;
  capability_checked_at: Date | null;
  capability_invalidated_at: Date | null;
  capability_revision: number;
}

const emptyProgress = (): CampaignRunProgressDto => ({
  total: 0, pending: 0, materialized: 0, processing: 0, dryRunCompleted: 0,
  accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0, unknown: 0,
  blocked: 0, cancelled: 0,
});

const mapProgress = (counts: Record<string, number>): CampaignRunProgressDto => ({
  ...emptyProgress(),
  total: Object.values(counts).reduce((total, value) => total + Number(value), 0),
  pending: Number(counts.PENDING ?? 0),
  materialized: Number(counts.MATERIALIZED ?? 0),
  processing: Number(counts.PROCESSING ?? 0),
  dryRunCompleted: Number(counts.DRY_RUN_COMPLETED ?? 0),
  accepted: Number(counts.ACCEPTED ?? 0),
  sent: Number(counts.SENT ?? 0),
  delivered: Number(counts.DELIVERED ?? 0),
  read: Number(counts.READ ?? 0),
  failed: Number(counts.FAILED ?? 0),
  unknown: Number(counts.UNKNOWN ?? 0),
  blocked: Number(counts.BLOCKED_CAPABILITY_CHANGED ?? 0),
  cancelled: Number(counts.CANCELLED ?? 0),
});

const runSelect = `
  SELECT cr.*,
    (SELECT count(*) FROM campaign_run_targets crt WHERE crt.run_id = cr.id) AS target_count,
    COALESCE(progress.delivery_counts, '{}'::jsonb) AS delivery_counts
  FROM campaign_runs cr
  LEFT JOIN LATERAL (
    SELECT jsonb_object_agg(status::text, status_count) AS delivery_counts
    FROM (
      SELECT status, count(*)::integer AS status_count
      FROM campaign_deliveries WHERE run_id = cr.id GROUP BY status
    ) delivery_statuses
  ) progress ON true`;

const mapRun = (row: CampaignRunRow): CampaignRunDto => ({
  id: row.id,
  campaignId: row.campaign_id,
  sessionId: row.session_id,
  executionMode: row.execution_mode,
  status: row.status,
  statusReason: row.status_reason,
  text: row.payload_snapshot.text,
  preflight: row.preflight_report,
  totalTargets: Number(row.target_count),
  progress: mapProgress(row.delivery_counts),
  scheduledAt: row.scheduled_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  createdAt: row.created_at,
});

const mapPreflightTarget = (row: PreflightTargetRow): CampaignTargetDto => ({
  groupId: row.group_id,
  groupName: row.group_name,
  enabled: true,
  sendCapability: {
    status: row.send_capability,
    reason: row.send_capability_reason,
    checkedAt: row.capability_checked_at,
    invalidatedAt: row.capability_invalidated_at,
    revision: row.capability_revision,
  },
});

const mapDelivery = (row: DeliveryRow): CampaignDeliveryDto => ({
  id: row.id,
  runId: row.run_id,
  groupId: row.group_id,
  groupName: row.group_name,
  messageJobId: row.message_job_id,
  status: row.status,
  failureReason: row.failure_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

@Injectable()
export class CampaignRunRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly messageJobs: MessageJobRepository,
  ) {}

  async create(input: { campaignId: string; idempotencyKey: string; executionMode: CampaignExecutionMode }): Promise<{
    run: CampaignRunDto | null;
    created: boolean;
    campaignFound: boolean;
    idempotencyConflict: boolean;
  }> {
    return this.database.transaction(async client => {
      const campaignResult = await client.query<{
        id: string;
        session_id: string;
        payload: { text: string };
        schedule_type: CampaignScheduleType;
        scheduled_at: Date | null;
      }>('SELECT id, session_id, payload, schedule_type, scheduled_at FROM campaigns WHERE id = $1 FOR SHARE', [input.campaignId]);
      const campaign = campaignResult.rows[0];
      if (!campaign) return { run: null, created: false, campaignFound: false, idempotencyConflict: false };

      const scheduledAt = campaign.schedule_type === 'ONCE' && campaign.scheduled_at
        ? campaign.scheduled_at
        : new Date();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO campaign_runs
           (campaign_id, session_id, idempotency_key, execution_mode, payload_snapshot, scheduled_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)
         ON CONFLICT (campaign_id, idempotency_key) DO NOTHING RETURNING id`,
        [campaign.id, campaign.session_id, input.idempotencyKey, input.executionMode,
          JSON.stringify(campaign.payload), scheduledAt],
      );
      if (!inserted.rows[0]) {
        const existing = await client.query<CampaignRunRow>(
          `${runSelect} WHERE cr.campaign_id = $1 AND cr.idempotency_key = $2`,
          [campaign.id, input.idempotencyKey],
        );
        const run = existing.rows[0]!;
        return {
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
      const result = await client.query<CampaignRunRow>(`${runSelect} WHERE cr.id = $1`, [runId]);
      return { run: mapRun(result.rows[0]!), created: true, campaignFound: true, idempotencyConflict: false };
    });
  }

  async find(id: string): Promise<CampaignRunDto | null> {
    const result = await this.database.query<CampaignRunRow>(`${runSelect} WHERE cr.id = $1`, [id]);
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async listByCampaign(campaignId: string, limit: number, offset: number) {
    const [rows, count] = await Promise.all([
      this.database.query<CampaignRunRow>(
        `${runSelect} WHERE cr.campaign_id = $1 ORDER BY cr.created_at DESC LIMIT $2 OFFSET $3`,
        [campaignId, limit, offset],
      ),
      this.database.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM campaign_runs WHERE campaign_id = $1', [campaignId],
      ),
    ]);
    return { data: rows.rows.map(mapRun), total: Number(count.rows[0]?.count ?? 0) };
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
    const result = await this.database.query(
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
       )`,
    );
    return result.rowCount ?? 0;
  }

  async getPreflightContext(runId: string): Promise<{
    run: CampaignRunDto;
    targets: CampaignTargetDto[];
  } | null> {
    const run = await this.find(runId);
    if (!run) return null;
    const result = await this.database.query<PreflightTargetRow>(
      `SELECT crt.group_id, crt.group_name, g.send_capability, g.send_capability_reason,
         g.capability_checked_at, g.capability_invalidated_at, g.capability_revision
       FROM campaign_run_targets crt
       JOIN gateway_groups g ON g.session_id = crt.session_id AND g.id = crt.group_id
       WHERE crt.run_id = $1 ORDER BY crt.group_name, crt.group_id`,
      [runId],
    );
    return { run, targets: result.rows.map(mapPreflightTarget) };
  }

  async applyPreflight(runId: string, leaseToken: string, report: CampaignPreflightDto): Promise<boolean> {
    return this.database.transaction(async client => {
      const locked = await client.query<{ status: string; scheduled_at: Date }>(
         `SELECT status, scheduled_at FROM campaign_runs
         WHERE id = $1 AND status = 'PREPARING' AND preparation_lease_token = $2
           AND preparation_lease_expires_at > now() FOR UPDATE`,
        [runId, leaseToken],
      );
      const run = locked.rows[0];
      if (!run) return false;
      if (report.status === 'BLOCK') {
        await client.query(
          `UPDATE campaign_runs SET status = 'BLOCKED', status_reason = 'PREFLIGHT_BLOCKED', preflight_status = $2,
             preflight_policy_version = $3, preflight_report = $4::jsonb,
             preparation_lease_token = NULL, preparation_lease_expires_at = NULL, updated_at = now()
           WHERE id = $1`,
          [runId, report.status, report.policyVersion, JSON.stringify(report)],
        );
        return true;
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
      return true;
    });
  }

  async failPreparationAttempt(
    runId: string,
    leaseToken: string,
    error: string,
  ): Promise<CampaignPreparationResult> {
    const result = await this.database.query<{ status: 'PREPARING' | 'FAILED' }>(
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
       RETURNING status`,
      [runId, leaseToken, error],
    );
    return result.rows[0]?.status ?? 'LOST_OWNERSHIP';
  }

  async activateDueRuns(): Promise<number> {
    const result = await this.database.query(
      `UPDATE campaign_runs SET status = 'RUNNING', status_reason = NULL,
         started_at = COALESCE(started_at, now()), updated_at = now()
       WHERE status = 'SCHEDULED' AND scheduled_at <= now()`,
    );
    return result.rowCount ?? 0;
  }

  async reconcileDeliveries(): Promise<number> {
    const result = await this.database.query(
      `UPDATE campaign_deliveries cd SET
         status = CASE mj.status
           WHEN 'PROCESSING' THEN 'PROCESSING'::campaign_delivery_status
           WHEN 'DRY_RUN_COMPLETED' THEN 'DRY_RUN_COMPLETED'::campaign_delivery_status
           WHEN 'ACCEPTED' THEN 'ACCEPTED'::campaign_delivery_status
           WHEN 'SENT' THEN 'SENT'::campaign_delivery_status
           WHEN 'DELIVERED' THEN 'DELIVERED'::campaign_delivery_status
           WHEN 'READ' THEN 'READ'::campaign_delivery_status
           WHEN 'FAILED' THEN 'FAILED'::campaign_delivery_status
           WHEN 'UNKNOWN' THEN 'UNKNOWN'::campaign_delivery_status
           WHEN 'CANCELLED' THEN 'CANCELLED'::campaign_delivery_status
           ELSE cd.status
         END,
         failure_reason = CASE WHEN mj.status IN ('FAILED','UNKNOWN') THEN mj.last_error ELSE cd.failure_reason END,
         updated_at = now()
       FROM message_jobs mj
       WHERE cd.message_job_id = mj.id
         AND mj.status IN ('PROCESSING','DRY_RUN_COMPLETED','ACCEPTED','SENT','DELIVERED','READ','FAILED','UNKNOWN','CANCELLED')
         AND (cd.status::text IS DISTINCT FROM mj.status::text
           OR (mj.status IN ('FAILED','UNKNOWN') AND cd.failure_reason IS DISTINCT FROM mj.last_error))`,
    );
    return result.rowCount ?? 0;
  }

  async finalizeRuns(limit: number): Promise<number> {
    const result = await this.database.query(
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
       FROM finalizable f WHERE cr.id = f.id`,
      [limit],
    );
    return result.rowCount ?? 0;
  }

  async pause(id: string): Promise<CampaignRunDto | null> {
    return this.database.transaction(async client => {
      const updated = await client.query(
        `UPDATE campaign_runs SET status = 'PAUSED', status_reason = 'MANUAL_PAUSE', updated_at = now()
         WHERE id = $1 AND status IN ('SCHEDULED','RUNNING') RETURNING id`, [id],
      );
      if (!updated.rows[0]) return null;
      const result = await client.query<CampaignRunRow>(`${runSelect} WHERE cr.id = $1`, [id]);
      return mapRun(result.rows[0]!);
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

  async resume(id: string, report: CampaignPreflightDto): Promise<CampaignRunDto | null> {
    return this.database.transaction(async client => {
      const locked = await client.query<{ status: string; scheduled_at: Date }>(
        `SELECT status, scheduled_at FROM campaign_runs WHERE id = $1 FOR UPDATE`, [id],
      );
      const run = locked.rows[0];
      if (!run || !['PAUSED', 'BLOCKED'].includes(run.status)) return null;
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
      const result = await client.query<CampaignRunRow>(`${runSelect} WHERE cr.id = $1`, [id]);
      return mapRun(result.rows[0]!);
    });
  }

  async cancel(id: string): Promise<CampaignRunDto | null> {
    return this.database.transaction(async client => {
      const locked = await client.query<{ status: string }>(
        `SELECT status FROM campaign_runs WHERE id = $1 FOR UPDATE`, [id],
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
      const result = await client.query<CampaignRunRow>(`${runSelect} WHERE cr.id = $1`, [id]);
      return mapRun(result.rows[0]!);
    });
  }

  async listRunningIds(limit: number): Promise<string[]> {
    const result = await this.database.query<{ id: string }>(
      `SELECT id FROM campaign_runs WHERE status = 'RUNNING' ORDER BY started_at, id LIMIT $1`, [limit],
    );
    return result.rows.map(row => row.id);
  }

  async materializePending(runId: string, maxBuffered: number): Promise<number> {
    return this.database.transaction(async client => {
      const runResult = await client.query<{
        session_id: string;
        execution_mode: CampaignExecutionMode;
        payload_snapshot: { text: string };
        status: string;
        session_status: string | null;
        engine_loaded: boolean | null;
        restriction: Record<string, unknown> | null;
      }>(`SELECT cr.session_id, cr.execution_mode, cr.payload_snapshot, cr.status,
             gs.status AS session_status, gs.engine_loaded, gs.restriction
           FROM campaign_runs cr LEFT JOIN gateway_sessions gs ON gs.id = cr.session_id
           WHERE cr.id = $1 FOR UPDATE OF cr`, [runId]);
      const run = runResult.rows[0];
      if (!run || run.status !== 'RUNNING') return 0;
      if (run.execution_mode === 'LIVE'
        && (run.session_status !== 'ready' || run.engine_loaded !== true || run.restriction != null)) {
        await client.query(
          `UPDATE campaign_runs SET status = 'PAUSED', status_reason = 'SESSION_NOT_SENDABLE', updated_at = now()
           WHERE id = $1 AND status = 'RUNNING'`, [runId],
        );
        return 0;
      }

      const activeResult = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM campaign_deliveries cd
         JOIN message_jobs mj ON mj.id = cd.message_job_id
         WHERE cd.run_id = $1 AND mj.status IN ('SCHEDULED','QUEUED','PROCESSING')`,
        [runId],
      );
      const slots = Math.max(0, maxBuffered - Number(activeResult.rows[0]?.count ?? 0));
      if (!slots) return 0;

      const pending = await client.query<{
        delivery_id: string;
        group_id: string;
        snapshot_revision: number;
        current_revision: number;
        current_capability: GroupSendCapabilityStatus;
      }>(
        `SELECT cd.id AS delivery_id, cd.group_id,
           crt.capability_revision AS snapshot_revision,
           g.capability_revision AS current_revision,
           g.send_capability AS current_capability
         FROM campaign_deliveries cd
         JOIN campaign_run_targets crt ON crt.run_id = cd.run_id AND crt.group_id = cd.group_id
         JOIN gateway_groups g ON g.session_id = crt.session_id AND g.id = crt.group_id
         WHERE cd.run_id = $1 AND cd.status = 'PENDING'
         ORDER BY cd.created_at, cd.id FOR UPDATE OF cd SKIP LOCKED LIMIT $2`,
        [runId, slots],
      );
      let materialized = 0;
      for (const delivery of pending.rows) {
        const capabilityChanged = delivery.snapshot_revision !== delivery.current_revision
          || delivery.current_capability !== 'ALLOWED';
        if (run.execution_mode === 'LIVE' && capabilityChanged) {
          await client.query(
            `UPDATE campaign_deliveries SET status = 'BLOCKED_CAPABILITY_CHANGED',
               failure_reason = 'Group capability changed after preflight', updated_at = now()
             WHERE id = $1`,
            [delivery.delivery_id],
          );
          continue;
        }
        const message = await this.messageJobs.createWithClient(client, {
          idempotencyScope: `campaign-run:${runId}`,
          idempotencyKey: delivery.group_id,
          requestHash: messageRequestHash({
            sessionId: run.session_id,
            recipientId: delivery.group_id,
            text: run.payload_snapshot.text,
            scheduledAt: null,
            dryRun: run.execution_mode === 'DRY_RUN',
          }),
          sessionId: run.session_id,
          recipientId: delivery.group_id,
          text: run.payload_snapshot.text,
          scheduledAt: new Date(),
          dryRun: run.execution_mode === 'DRY_RUN',
        });
        await client.query(
          `UPDATE campaign_deliveries SET message_job_id = $2, status = 'MATERIALIZED', updated_at = now()
           WHERE id = $1 AND status = 'PENDING'`,
          [delivery.delivery_id, message.job.id],
        );
        materialized += 1;
      }
      return materialized;
    });
  }

  async listDeliveries(runId: string, limit: number, offset: number) {
    const [rows, count] = await Promise.all([
      this.database.query<DeliveryRow>(
        `SELECT cd.*, crt.group_name FROM campaign_deliveries cd
         JOIN campaign_run_targets crt ON crt.run_id = cd.run_id AND crt.group_id = cd.group_id
         WHERE cd.run_id = $1 ORDER BY cd.created_at, cd.id LIMIT $2 OFFSET $3`,
        [runId, limit, offset],
      ),
      this.database.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM campaign_deliveries WHERE run_id = $1', [runId],
      ),
    ]);
    return { data: rows.rows.map(mapDelivery), total: Number(count.rows[0]?.count ?? 0) };
  }
}
