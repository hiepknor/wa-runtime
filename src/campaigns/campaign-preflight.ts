import { CampaignExecutionMode, type CampaignPreflightDto } from '../contracts/campaigns/campaign-preflight.dto';
import type { CampaignTargetDto } from '../contracts/campaigns/campaign-target.dto';

export interface PreflightSessionState {
  status: string;
  engineLoaded: boolean;
  restricted: boolean;
}

export function evaluateCampaignPreflight(input: {
  executionMode: CampaignExecutionMode;
  text: string;
  targets: CampaignTargetDto[];
  session: PreflightSessionState;
  liveSendsEnabled: boolean;
  checkedAt?: Date;
}): CampaignPreflightDto {
  const checks: CampaignPreflightDto['checks'] = [];
  const targetIssues = input.targets
    .filter(target => target.sendCapability.status !== 'ALLOWED')
    .map(target => ({
      groupId: target.groupId,
      groupName: target.groupName,
      capability: target.sendCapability.status,
      reason: target.sendCapability.reason,
    }));
  const allowedTargets = input.targets.length - targetIssues.length;
  const deniedTargets = targetIssues.filter(target => target.capability === 'DENIED').length;
  const unknownTargets = targetIssues.filter(target => target.capability === 'UNKNOWN').length;

  checks.push({
    code: 'CONTENT_VALID',
    status: input.text.trim() && input.text.length <= 4096 ? 'PASS' : 'BLOCK',
    message: input.text.trim() && input.text.length <= 4096 ? 'Text content is valid' : 'Text content is invalid',
  });
  checks.push({
    code: 'TARGETS_VALID',
    status: input.targets.length ? 'PASS' : 'BLOCK',
    message: input.targets.length ? `${input.targets.length} target groups selected` : 'At least one target group is required',
  });
  const sessionReady = input.session.status === 'ready' && input.session.engineLoaded && !input.session.restricted;
  checks.push({
    code: 'SESSION_SENDABLE',
    status: sessionReady ? 'PASS' : 'BLOCK',
    message: sessionReady ? 'Session is ready' : 'Session is not ready or is restricted',
  });
  checks.push({
    code: 'GROUP_CAPABILITY',
    status: targetIssues.length
      ? input.executionMode === CampaignExecutionMode.DRY_RUN ? 'WARN' : 'BLOCK'
      : 'PASS',
    message: targetIssues.length
      ? `${targetIssues.length} targets are denied or unknown`
      : 'All targets have current send capability',
  });
  checks.push({
    code: 'LIVE_SEND_ALLOWED',
    status: input.executionMode === CampaignExecutionMode.LIVE && !input.liveSendsEnabled ? 'BLOCK' : 'PASS',
    message: input.executionMode === CampaignExecutionMode.LIVE
      ? input.liveSendsEnabled ? 'Live sends are enabled' : 'Live sends are disabled'
      : 'Dry-run does not require live sends',
  });

  const status = checks.some(check => check.status === 'BLOCK')
    ? 'BLOCK'
    : checks.some(check => check.status === 'WARN') ? 'WARN' : 'PASS';
  return {
    status,
    policyVersion: 1,
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
