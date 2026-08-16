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

describe('saved group-list OpenAPI contract', () => {
  it('publishes the complete resource surface and required idempotency header', () => {
    expect(Object.keys(contract.paths)).toEqual(expect.arrayContaining([
      '/api/v1/group-lists',
      '/api/v1/group-lists/{id}',
      '/api/v1/group-lists/{id}/groups',
    ]));
    const post = contract.paths['/api/v1/group-lists']?.post;
    expect(post?.parameters).toContainEqual(expect.objectContaining({
      name: 'Idempotency-Key', required: true,
      schema: { type: 'string', format: 'uuid' },
    }));
    expect(post?.responses).toEqual(expect.objectContaining({
      200: expect.any(Object),
      201: expect.any(Object),
      400: expect.any(Object),
      404: expect.any(Object),
      409: expect.any(Object),
      422: expect.any(Object),
    }));
  });

  it('publishes bounded static membership and nullable current group metadata', () => {
    const create = contract.components.schemas.CreateGroupListDto!;
    expect(create.required).toEqual(['sessionId', 'name']);
    expect(create.properties.groupIds).toMatchObject({
      type: 'array', maxItems: 1000, uniqueItems: true,
    });
    expect(create.properties.description).toMatchObject({ type: 'string', nullable: true, maxLength: 500 });
    expect(contract.components.schemas.UpdateGroupListDto?.properties.expectedRevision)
      .toMatchObject({ type: 'integer', minimum: 1 });
    expect(contract.components.schemas.ReplaceGroupListGroupsDto?.properties.expectedRevision)
      .toMatchObject({ type: 'integer', minimum: 1 });
    expect(contract.components.schemas.ReplaceGroupListGroupsDto?.properties.expectedMembershipRevision)
      .toMatchObject({ type: 'integer', minimum: 1 });

    const membership = contract.components.schemas.GroupListMembershipDto!;
    expect(membership.required).toEqual(['list', 'data']);
    expect(membership.properties.data).toMatchObject({ type: 'array', maxItems: 1000 });
    const group = contract.components.schemas.GroupListGroupDto!;
    expect(group.required).toEqual([
      'groupId', 'groupName', 'isActive', 'participantsCount', 'sendCapability',
    ]);
    expect(group.properties.participantsCount).toMatchObject({ type: 'number', nullable: true });
  });

  it('publishes stable saved-list metadata and filter-before-pagination query semantics', () => {
    const list = contract.components.schemas.SavedGroupListDto!;
    expect(list.required).toEqual([
      'id', 'sessionId', 'name', 'description', 'groupCount', 'revision',
      'membershipRevision', 'archivedAt', 'createdAt', 'updatedAt',
    ]);
    expect(list.properties.groupCount).toMatchObject({ type: 'integer', minimum: 0 });
    expect(list.properties.revision).toMatchObject({ type: 'integer', minimum: 1 });
    expect(list.properties.membershipRevision).toMatchObject({ type: 'integer', minimum: 1 });
    expect(list.properties.archivedAt).toMatchObject({ type: 'string', format: 'date-time', nullable: true });

    const get = contract.paths['/api/v1/group-lists']?.get;
    const parameters = new Map<string, Record<string, any>>((get?.parameters ?? []).map((parameter: Record<string, any>) => [
      parameter.name, parameter,
    ]));
    expect(parameters.get('sessionId')).toMatchObject({ required: true, in: 'query' });
    expect(parameters.get('query')?.schema).toMatchObject({ type: 'string', maxLength: 200 });
    expect(parameters.get('limit')?.schema).toMatchObject({ minimum: 1, maximum: 200, default: 50 });
    expect(parameters.get('offset')?.schema).toMatchObject({ minimum: 0, default: 0 });
    expect(get?.description).toContain('applied before pagination');

    const archiveParameters = contract.paths['/api/v1/group-lists/{id}']?.delete?.parameters ?? [];
    expect(archiveParameters).toContainEqual(expect.objectContaining({
      name: 'expectedRevision', required: false,
      schema: expect.objectContaining({ type: 'integer', minimum: 1 }),
    }));
    expect(contract.paths['/api/v1/group-lists/{id}']?.delete?.description)
      .toContain('repeated DELETE succeeds');
  });

  it('documents typed errors for every saved-list operation', () => {
    for (const path of [
      '/api/v1/group-lists',
      '/api/v1/group-lists/{id}',
      '/api/v1/group-lists/{id}/groups',
    ]) {
      for (const operation of Object.values(contract.paths[path] ?? {})) {
        for (const status of ['400', '404', '409', '422']) {
          expect(operation.responses[status]?.content?.['application/json']?.schema?.$ref)
            .toBe('#/components/schemas/RuntimeErrorDto');
        }
      }
    }
  });
});
