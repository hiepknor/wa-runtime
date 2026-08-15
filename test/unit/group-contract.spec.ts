import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Parameter {
  name: string;
  schema?: { type?: string; format?: string; minimum?: number; maximum?: number; maxLength?: number };
}

const contract = JSON.parse(readFileSync(
  resolve(process.cwd(), 'contracts/runtime/v1/openapi.json'), 'utf8',
)) as {
  paths: Record<string, Record<string, { parameters?: Parameter[]; responses?: Record<string, unknown> }>>;
};

describe('group OpenAPI contract', () => {
  it('publishes optional non-negative integer participant bounds and typed bad requests', () => {
    const operation = contract.paths['/api/v1/groups']?.get;
    const parameters = new Map((operation?.parameters ?? []).map(parameter => [parameter.name, parameter]));
    expect(parameters.get('minParticipants')?.schema).toMatchObject({
      type: 'integer', format: 'int32', minimum: 0, maximum: 2_147_483_647,
    });
    expect(parameters.get('maxParticipants')?.schema).toMatchObject({
      type: 'integer', format: 'int32', minimum: 0, maximum: 2_147_483_647,
    });
    expect(parameters.get('query')?.schema).toMatchObject({ type: 'string', maxLength: 200 });
    expect(operation?.responses).toHaveProperty('400');
    expect(contract.paths['/api/v1/groups/{id}']?.get?.responses).toHaveProperty('404');
    expect(contract.paths['/api/v1/groups/{id}/members']?.get?.responses).toHaveProperty('400');
    expect(contract.paths['/api/v1/groups/{id}/members']?.get?.responses).toHaveProperty('404');
  });
});
