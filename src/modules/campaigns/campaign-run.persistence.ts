import type { PoolClient } from 'pg';
import type { CampaignExecutionMode, CampaignPreflightDto } from '../../contracts/campaigns/campaign-preflight.dto';
import type { CampaignRunDto, CampaignRunProgressDto } from '../../contracts/campaigns/campaign-run.dto';
import type { CampaignTargetDto } from '../../contracts/campaigns/campaign-target.dto';
import type { GroupSendCapabilityStatus } from '../gateway/group-capability';

export interface CampaignRunRow {
  id: string;
  campaign_id: string;
  session_id: string;
  idempotency_key: string;
  execution_mode: CampaignExecutionMode;
  status: string;
  status_reason: string | null;
  payload_snapshot: { text: string };
  campaign_revision: string | number;
  targets_revision: string | number;
  target_source_group_list_id: string | null;
  target_source_group_list_name_snapshot: string | null;
  target_source_membership_revision: string | number | null;
  target_source_applied_at: Date | null;
  preflight_report: CampaignPreflightDto | null;
  scheduled_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  target_count: string | number;
  delivery_counts: Record<string, number>;
}

export interface PreflightTargetRow {
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

export const campaignRunSelect = `
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

export const mapCampaignRun = (row: CampaignRunRow): CampaignRunDto => ({
  id: row.id,
  campaignId: row.campaign_id,
  sessionId: row.session_id,
  executionMode: row.execution_mode,
  status: row.status,
  statusReason: row.status_reason,
  text: row.payload_snapshot.text,
  targetSource: row.target_source_group_list_id
    && row.target_source_group_list_name_snapshot
    && row.target_source_membership_revision
    && row.target_source_applied_at
    ? {
        type: 'GROUP_LIST',
        groupListId: row.target_source_group_list_id,
        groupListNameSnapshot: row.target_source_group_list_name_snapshot,
        membershipRevision: Number(row.target_source_membership_revision),
        appliedAt: row.target_source_applied_at,
      }
    : null,
  preflight: row.preflight_report,
  totalTargets: Number(row.target_count),
  progress: mapProgress(row.delivery_counts),
  scheduledAt: row.scheduled_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  createdAt: row.created_at,
});

export const mapPreflightTarget = (row: PreflightTargetRow): CampaignTargetDto => ({
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

export const capabilitySnapshotChanged = async (
  client: PoolClient,
  runId: string,
  observedTargets: CampaignTargetDto[],
): Promise<boolean> => {
  if (!observedTargets.length) return false;
  const current = await client.query<{ stale: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM unnest($2::text[], $3::integer[]) AS expected(group_id, capability_revision)
       LEFT JOIN campaign_run_targets crt
         ON crt.run_id = $1 AND crt.group_id = expected.group_id
       LEFT JOIN gateway_groups g
         ON g.session_id = crt.session_id AND g.id = crt.group_id
       WHERE g.id IS NULL OR g.capability_revision <> expected.capability_revision
     ) AS stale`,
    [runId, observedTargets.map(target => target.groupId),
      observedTargets.map(target => target.sendCapability.revision)],
  );
  return current.rows[0]?.stale ?? false;
};
