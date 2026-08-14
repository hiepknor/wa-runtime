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
      'TARGET_CAPABILITY_DENIED', 'TARGET_CAPABILITY_UNKNOWN',
    ]);
    expect(contract.components.schemas.CampaignTargetDto?.required).toEqual([
      'groupId', 'groupName', 'enabled', 'sendCapability',
    ]);
    expect(contract.components.schemas.RuntimeErrorDto?.required).toEqual(['code', 'message']);
  });

  it('requires an idempotency key for campaign creation', () => {
    const parameters = contract.paths['/api/v1/campaigns']?.post?.parameters ?? [];
    expect(parameters).toContainEqual(expect.objectContaining({ name: 'Idempotency-Key', required: true }));
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
