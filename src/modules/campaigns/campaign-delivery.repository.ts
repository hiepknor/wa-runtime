import type { CampaignDeliveryDto } from '../../contracts/campaigns/campaign-delivery.dto';
import type { CampaignExecutionMode } from '../../contracts/campaigns/campaign-preflight.dto';
import { DatabaseService } from '../../core/database/database.service';
import type { GroupSendCapabilityStatus } from '../gateway/group-capability';
import { messageRequestHash } from '../messages/message-idempotency';
import { MessageJobRepository } from '../messages/message-job.repository';

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

export class CampaignDeliveryRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly messageJobs: MessageJobRepository,
  ) {}

  async reconcile(): Promise<number> {
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

  async materializePending(runId: string, maxBuffered: number): Promise<number> {
    return this.database.transaction(async client => {
      const runResult = await client.query<{
        campaign_id: string;
        session_id: string;
        execution_mode: CampaignExecutionMode;
        payload_snapshot: { text: string };
        status: string;
        session_status: string | null;
        engine_loaded: boolean | null;
        restriction: Record<string, unknown> | null;
      }>(`SELECT cr.campaign_id, cr.session_id, cr.execution_mode, cr.payload_snapshot, cr.status,
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
        await client.query(
          `UPDATE campaigns SET status = 'PAUSED', updated_at = now()
           WHERE id = $1 AND status = 'ACTIVE'`,
          [run.campaign_id],
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

  async list(runId: string, limit: number, offset: number) {
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
