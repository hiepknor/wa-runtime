import {
  CampaignExecutionMode,
  CampaignPreflightCheckCode,
  CampaignPreflightStatus,
  CampaignTargetIssueReason,
  type CampaignPreflightDto,
} from '../../contracts/campaigns/campaign-preflight.dto';
import type { CampaignTargetDto } from '../../contracts/campaigns/campaign-target.dto';

export interface CampaignPreflightSessionState {
  status: string;
  engineLoaded: boolean;
  restricted: boolean;
}

export function evaluateCampaignPreflight(input: {
  executionMode: CampaignExecutionMode;
  text: string;
  targets: CampaignTargetDto[];
  session: CampaignPreflightSessionState;
  liveSendsEnabled: boolean;
  campaignRevision: number;
  targetsRevision: number;
  checkedAt?: Date;
}): CampaignPreflightDto {
  const checks: CampaignPreflightDto['checks'] = [];
  const targetIssues = input.targets
    .map(target => ({
      target,
      effectiveCapability: target.sendCapability.invalidatedAt === null
        ? target.sendCapability.status
        : 'UNKNOWN' as const,
    }))
    .filter(({ effectiveCapability }) => effectiveCapability !== 'ALLOWED')
    .map(({ target, effectiveCapability }) => ({
      groupId: target.groupId,
      groupName: target.groupName,
      capability: effectiveCapability,
      reason: target.sendCapability.invalidatedAt !== null
        ? CampaignTargetIssueReason.TARGET_CAPABILITY_STALE
        : effectiveCapability === 'DENIED'
          ? CampaignTargetIssueReason.TARGET_CAPABILITY_DENIED
          : CampaignTargetIssueReason.TARGET_CAPABILITY_UNKNOWN,
    }));
  const allowedTargets = input.targets.length - targetIssues.length;
  const deniedTargets = targetIssues.filter(target => target.capability === 'DENIED').length;
  const unknownTargets = targetIssues.filter(target => target.capability === 'UNKNOWN').length;

  checks.push({
    code: CampaignPreflightCheckCode.CONTENT_VALID,
    status: input.text.trim() && input.text.length <= 4096
      ? CampaignPreflightStatus.PASS : CampaignPreflightStatus.BLOCK,
    message: input.text.trim() && input.text.length <= 4096 ? 'Text content is valid' : 'Text content is invalid',
  });
  checks.push({
    code: CampaignPreflightCheckCode.TARGETS_VALID,
    status: input.targets.length ? CampaignPreflightStatus.PASS : CampaignPreflightStatus.BLOCK,
    message: input.targets.length ? `${input.targets.length} target groups selected` : 'At least one target group is required',
  });
  const sessionReady = input.session.status === 'ready' && input.session.engineLoaded && !input.session.restricted;
  checks.push({
    code: CampaignPreflightCheckCode.SESSION_SENDABLE,
    status: sessionReady ? CampaignPreflightStatus.PASS : CampaignPreflightStatus.BLOCK,
    message: sessionReady ? 'Session is ready' : 'Session is not ready or is restricted',
  });
  checks.push({
    code: CampaignPreflightCheckCode.GROUP_CAPABILITY,
    status: targetIssues.length
      ? input.executionMode === CampaignExecutionMode.DRY_RUN
        ? CampaignPreflightStatus.WARN : CampaignPreflightStatus.BLOCK
      : CampaignPreflightStatus.PASS,
    message: targetIssues.length
      ? `${targetIssues.length} targets are denied or unknown`
      : 'All targets have current send capability',
  });
  checks.push({
    code: CampaignPreflightCheckCode.LIVE_SEND_ALLOWED,
    status: input.executionMode === CampaignExecutionMode.LIVE && !input.liveSendsEnabled
      ? CampaignPreflightStatus.BLOCK : CampaignPreflightStatus.PASS,
    message: input.executionMode === CampaignExecutionMode.LIVE
      ? input.liveSendsEnabled ? 'Live sends are enabled' : 'Live sends are disabled'
      : 'Dry-run does not require live sends',
  });

  const status = checks.some(check => check.status === CampaignPreflightStatus.BLOCK)
    ? CampaignPreflightStatus.BLOCK
    : checks.some(check => check.status === CampaignPreflightStatus.WARN)
      ? CampaignPreflightStatus.WARN : CampaignPreflightStatus.PASS;
  return {
    status,
    policyVersion: 2,
    campaignRevision: input.campaignRevision,
    targetsRevision: input.targetsRevision,
    executionMode: input.executionMode,
    checkedAt: input.checkedAt ?? new Date(),
    totalTargets: input.targets.length,
    allowedTargets,
    deniedTargets,
    unknownTargets,
    checks,
    targetIssues,
  };
}
