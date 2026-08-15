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
const revisions = { campaignRevision: 7, targetsRevision: 4 };

describe('evaluateCampaignPreflight', () => {
  it('publishes policy version 2 for invalidation-aware capability semantics', () => {
    expect(evaluateCampaignPreflight({
      executionMode: CampaignExecutionMode.DRY_RUN,
      text: 'hello', targets: [target('ALLOWED')], session: ready, liveSendsEnabled: false, ...revisions,
    }).policyVersion).toBe(2);
  });

  it('passes a live campaign only when all capabilities and the kill switch allow it', () => {
    const report = evaluateCampaignPreflight({
      executionMode: CampaignExecutionMode.LIVE,
      text: 'hello',
      targets: [target('ALLOWED')],
      session: ready,
      liveSendsEnabled: true,
      ...revisions,
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
      ...revisions,
    });
    expect(report.status).toBe('WARN');
    expect(report).toMatchObject({ allowedTargets: 1, deniedTargets: 1, unknownTargets: 1 });
    expect(report.totalTargets).toBe(report.allowedTargets + report.deniedTargets + report.unknownTargets);
    expect(report.targetIssues.map(issue => issue.reason)).toEqual([
      'TARGET_CAPABILITY_DENIED', 'TARGET_CAPABILITY_UNKNOWN',
    ]);
    expect(report).toMatchObject(revisions);
  });

  it('blocks live runs when the session, targets or live-send interlock is unsafe', () => {
    const report = evaluateCampaignPreflight({
      executionMode: CampaignExecutionMode.LIVE,
      text: 'hello',
      targets: [target('UNKNOWN')],
      session: { status: 'disconnected', engineLoaded: true, restricted: false },
      liveSendsEnabled: false,
      ...revisions,
    });
    expect(report.status).toBe('BLOCK');
    expect(report.checks.filter(check => check.status === 'BLOCK').map(check => check.code)).toEqual([
      'SESSION_SENDABLE', 'GROUP_CAPABILITY', 'LIVE_SEND_ALLOWED',
    ]);
  });

  it('applies BLOCK over WARN over PASS precedence using stable check codes', () => {
    const warn = evaluateCampaignPreflight({
      executionMode: CampaignExecutionMode.DRY_RUN,
      text: 'hello', targets: [target('UNKNOWN')], session: ready, liveSendsEnabled: false, ...revisions,
    });
    expect(warn.status).toBe('WARN');
    expect(warn.checks.map(check => check.code)).toEqual([
      'CONTENT_VALID', 'TARGETS_VALID', 'SESSION_SENDABLE', 'GROUP_CAPABILITY', 'LIVE_SEND_ALLOWED',
    ]);

    const block = evaluateCampaignPreflight({
      executionMode: CampaignExecutionMode.DRY_RUN,
      text: '', targets: [target('UNKNOWN')], session: ready, liveSendsEnabled: false, ...revisions,
    });
    expect(block.checks.some(check => check.status === 'WARN')).toBe(true);
    expect(block.status).toBe('BLOCK');
  });

  it('treats an invalidated ALLOWED capability as effectively UNKNOWN', () => {
    const stale = target('ALLOWED');
    stale.sendCapability.invalidatedAt = new Date();
    const report = evaluateCampaignPreflight({
      executionMode: CampaignExecutionMode.LIVE,
      text: 'hello', targets: [stale], session: ready, liveSendsEnabled: true, ...revisions,
    });
    expect(report.status).toBe('BLOCK');
    expect(report).toMatchObject({ allowedTargets: 0, unknownTargets: 1 });
    expect(report.targetIssues).toEqual([
      expect.objectContaining({ capability: 'UNKNOWN', reason: 'TARGET_CAPABILITY_STALE' }),
    ]);
  });
});
