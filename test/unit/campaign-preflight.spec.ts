import { describe, expect, it } from 'vitest';
import { CampaignExecutionMode } from '../../src/contracts/campaigns/campaign-preflight.dto';
import type { CampaignTargetDto } from '../../src/contracts/campaigns/campaign-target.dto';
import { evaluateCampaignPreflight } from '../../src/modules/campaigns/campaign-preflight';

const target = (status: 'ALLOWED' | 'DENIED' | 'UNKNOWN'): CampaignTargetDto => ({
  groupId: `${status.toLowerCase()}@g.us`,
  groupName: status,
  enabled: true,
  sendCapability: {
    status,
    reason: status === 'ALLOWED' ? 'SEND_ALLOWED' : 'TEST_REASON',
    checkedAt: new Date(),
    invalidatedAt: null,
    revision: 1,
  },
});

const ready = { status: 'ready', engineLoaded: true, restricted: false };

describe('evaluateCampaignPreflight', () => {
  it('passes a live campaign only when all capabilities and the kill switch allow it', () => {
    const report = evaluateCampaignPreflight({
      executionMode: CampaignExecutionMode.LIVE,
      text: 'hello',
      targets: [target('ALLOWED')],
      session: ready,
      liveSendsEnabled: true,
    });
    expect(report.status).toBe('PASS');
  });

  it('warns but permits a dry-run containing denied and unknown groups', () => {
    const report = evaluateCampaignPreflight({
      executionMode: CampaignExecutionMode.DRY_RUN,
      text: 'hello',
      targets: [target('ALLOWED'), target('DENIED'), target('UNKNOWN')],
      session: ready,
      liveSendsEnabled: false,
    });
    expect(report.status).toBe('WARN');
    expect(report).toMatchObject({ allowedTargets: 1, deniedTargets: 1, unknownTargets: 1 });
  });

  it('blocks live runs when the session, targets or live-send interlock is unsafe', () => {
    const report = evaluateCampaignPreflight({
      executionMode: CampaignExecutionMode.LIVE,
      text: 'hello',
      targets: [target('UNKNOWN')],
      session: { status: 'disconnected', engineLoaded: true, restricted: false },
      liveSendsEnabled: false,
    });
    expect(report.status).toBe('BLOCK');
    expect(report.checks.filter(check => check.status === 'BLOCK').map(check => check.code)).toEqual([
      'SESSION_SENDABLE', 'GROUP_CAPABILITY', 'LIVE_SEND_ALLOWED',
    ]);
  });
});
