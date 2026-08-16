import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Schema {
  type?: string;
  format?: string;
  nullable?: boolean;
  enum?: string[];
  properties?: Record<string, Schema>;
  required?: string[];
}

const contract = JSON.parse(readFileSync(
  resolve(process.cwd(), 'contracts/runtime/v1/openapi.json'), 'utf8',
)) as {
  components: { schemas: Record<string, Schema> };
  paths: Record<string, Record<string, { parameters?: Array<{ name: string; required?: boolean }> }>>;
};

describe('campaign OpenAPI contract', () => {
  it('publishes nullable date-time scheduling instead of an empty object type', () => {
    const scheduledAt = contract.components.schemas.UpdateCampaignDto?.properties?.scheduledAt;
    expect(scheduledAt).toMatchObject({ type: 'string', format: 'date-time', nullable: true });
    expect(contract.components.schemas.CreateCampaignDto?.required).not.toContain('scheduleType');
  });

  it('publishes revisions, stable preflight enums, target fields, and typed errors', () => {
    expect(contract.components.schemas.CampaignDto?.required).toEqual(expect.arrayContaining([
      'revision', 'targetsRevision', 'scheduledAt',
    ]));
    expect(contract.components.schemas.CampaignPreflightDto?.required).toEqual(expect.arrayContaining([
      'campaignRevision', 'targetsRevision', 'checks', 'targetIssues',
    ]));
    expect(contract.components.schemas.CampaignPreflightCheckDto?.properties?.code?.enum).toEqual([
      'CONTENT_VALID', 'TARGETS_VALID', 'SESSION_SENDABLE', 'GROUP_CAPABILITY', 'LIVE_SEND_ALLOWED',
    ]);
    expect(contract.components.schemas.CampaignTargetIssueDto?.properties?.reason?.enum).toEqual([
      'TARGET_CAPABILITY_DENIED', 'TARGET_CAPABILITY_UNKNOWN', 'TARGET_CAPABILITY_STALE',
    ]);
    expect(contract.components.schemas.CampaignTargetDto?.required).toEqual([
      'groupId', 'groupName', 'enabled', 'sendCapability',
    ]);
    expect(contract.components.schemas.CampaignTargetListDto?.required).toEqual([
      'data', 'targetsRevision', 'source',
    ]);
    expect(contract.components.schemas.ApplyGroupListTargetsDto?.properties).toEqual(expect.objectContaining({
      groupListId: expect.objectContaining({ format: 'uuid' }),
      expectedMembershipRevision: expect.objectContaining({ minimum: 1 }),
      expectedTargetsRevision: expect.objectContaining({ minimum: 0 }),
    }));
    const apply = contract.paths['/api/v1/campaigns/{id}/targets/apply-group-list']?.post as Record<string, any>;
    expect(apply.responses).toHaveProperty('200');
    expect(apply.responses).not.toHaveProperty('201');
    const preflight = contract.paths['/api/v1/campaigns/{id}/preflight']?.post as Record<string, any>;
    expect(preflight.responses).toHaveProperty('200');
    expect(preflight.responses).not.toHaveProperty('201');
    expect(contract.components.schemas.CampaignTargetSourceDto?.required).toEqual([
      'type', 'groupListId', 'groupListNameSnapshot', 'membershipRevision', 'appliedAt',
    ]);
    expect(contract.components.schemas.CampaignTargetSourceDto?.properties?.groupListNameSnapshot)
      .toMatchObject({ type: 'string' });
    expect(contract.components.schemas.CampaignRunDto?.required).toContain('targetSource');
    expect(contract.components.schemas.RuntimeErrorDto?.required).toEqual(['code', 'message']);
    expect(contract.components.schemas.UpdateCampaignDto?.properties?.expectedRevision).toMatchObject({
      type: 'integer', minimum: 1,
    });
    expect(contract.components.schemas.ReplaceCampaignTargetsDto?.properties?.expectedTargetsRevision)
      .toMatchObject({ type: 'integer', minimum: 0 });
  });

  it('requires an idempotency key for campaign creation', () => {
    const parameters = contract.paths['/api/v1/campaigns']?.post?.parameters ?? [];
    expect(parameters).toContainEqual(expect.objectContaining({ name: 'Idempotency-Key', required: true }));
  });

  it('publishes revision-fenced idempotent campaign deletion', () => {
    const operation = contract.paths['/api/v1/campaigns/{id}']?.delete as Record<string, any>;
    const parameters = new Map<string, Record<string, any>>(
      (operation.parameters ?? []).map((parameter: Record<string, any>) => [parameter.name, parameter]),
    );
    expect(parameters.get('expectedRevision')).toMatchObject({
      in: 'query', required: true, schema: { type: 'integer', minimum: 1 },
    });
    expect(parameters.get('expectedTargetsRevision')).toMatchObject({
      in: 'query', required: true, schema: { type: 'integer', minimum: 0 },
    });
    expect(operation.description).toContain('tombstone');
    expect(operation.responses).toEqual(expect.objectContaining({
      204: expect.any(Object), 400: expect.any(Object), 404: expect.any(Object), 409: expect.any(Object),
    }));
    expect(contract.components.schemas.CampaignDto?.properties).not.toHaveProperty('deletedAt');
  });

  it('publishes typed errors for campaign-run operations', () => {
    const createRun = contract.paths['/api/v1/campaigns/{id}/runs']?.post as Record<string, any>;
    expect(createRun.responses).toHaveProperty('400');
    expect(createRun.responses).toHaveProperty('409');
    const getRun = contract.paths['/api/v1/campaign-runs/{id}']?.get as Record<string, any>;
    expect(getRun.responses).toHaveProperty('404');
    expect(contract.components.schemas.CreateCampaignRunDto?.properties).toEqual(expect.objectContaining({
      expectedCampaignRevision: expect.objectContaining({ minimum: 1 }),
      expectedTargetsRevision: expect.objectContaining({ minimum: 0 }),
    }));
    expect(contract.components.schemas.CreateCampaignRunDto?.required).toEqual(['executionMode']);
  });

  it('publishes comma-separated campaign list filters and the bounded search query', () => {
    const parameters = contract.paths['/api/v1/campaigns']?.get?.parameters ?? [];
    const byName = new Map(parameters.map(parameter => [parameter.name, parameter as Record<string, any>]));
    expect(byName.get('query')?.schema).toMatchObject({ type: 'string', maxLength: 200 });
    expect(byName.get('status')).toMatchObject({ style: 'form', explode: false });
    expect(byName.get('status')?.schema?.items?.enum).toEqual(['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED']);
    expect(byName.get('scheduleType')).toMatchObject({ style: 'form', explode: false });
    expect(byName.get('scheduleType')?.schema?.items?.enum).toEqual(['IMMEDIATE', 'ONCE']);
  });
});
