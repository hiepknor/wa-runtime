import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const contract = JSON.parse(readFileSync(
  resolve(process.cwd(), 'contracts/runtime/v1/openapi.json'),
  'utf8',
)) as {
  components: { schemas: Record<string, Record<string, any>> };
  paths: Record<string, Record<string, Record<string, any>>>;
};

describe('health OpenAPI contract', () => {
  it('publishes process degradation separately from dependency readiness', () => {
    const operation = contract.paths['/api/v1/health/ready']?.get;
    expect(operation?.responses['200']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/HealthReadyDto' });
    expect(operation?.responses['503']?.content?.['application/json']?.schema)
      .toEqual({ $ref: '#/components/schemas/HealthNotReadyDto' });

    const ready = contract.components.schemas.HealthReadyDto!;
    expect(ready.required).toEqual([
      'status', 'dependencies', 'processes', 'liveSendsEnabled',
      'openwaRelease', 'allowedSessionCount',
    ]);
    expect(contract.components.schemas.RuntimeProcessHealthDto?.properties).toMatchObject({
      worker: { enum: ['healthy', 'degraded'] },
      scheduler: { enum: ['healthy', 'degraded'] },
    });
  });
});
