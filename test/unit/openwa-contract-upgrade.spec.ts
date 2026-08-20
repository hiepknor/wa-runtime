import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface OpenWAContract {
  info: { version: string };
  paths: Record<string, unknown>;
  components: { schemas: Record<string, unknown> };
}

type JsonObject = Record<string, unknown>;

const readContract = (release: string): OpenWAContract => JSON.parse(readFileSync(
  resolve(process.cwd(), 'contracts', 'openwa', release, 'openapi.json'),
  'utf8',
)) as OpenWAContract;

const operation = (contract: OpenWAContract, path: string, method: string): JsonObject => {
  const pathItem = contract.paths[path] as JsonObject | undefined;
  const value = pathItem?.[method] as JsonObject | undefined;
  if (!value) throw new Error(`Missing ${method.toUpperCase()} ${path}`);
  return value;
};

const schema = (contract: OpenWAContract, name: string): JsonObject => {
  const value = contract.components.schemas[name] as JsonObject | undefined;
  if (!value) throw new Error(`Missing schema ${name}`);
  return value;
};

const responseMap = (value: JsonObject): JsonObject => value.responses as JsonObject;
const properties = (value: JsonObject): JsonObject => value.properties as JsonObject;

describe('OpenWA 0.22.0 contract review', () => {
  const previous = readContract('0.18.0');
  const current = readContract('0.22.0');

  it('pins the expected upstream artifact and keeps unchanged Runtime operations stable', () => {
    expect(current.info.version).toBe('0.22.0');

    for (const [path, method] of [
      ['/api/health', 'get'],
      ['/api/sessions', 'get'],
      ['/api/sessions/{sessionId}/groups/{groupId}', 'get'],
      ['/api/sessions/{sessionId}/webhooks', 'get'],
      ['/api/sessions/{sessionId}/webhooks/{id}', 'put'],
      ['/api/sessions/{sessionId}/webhooks/{id}', 'delete'],
    ] as const) {
      expect(operation(current, path, method)).toEqual(operation(previous, path, method));
    }
  });

  it('accepts the reviewed path-parameter rename and response documentation changes', () => {
    const getSession = structuredClone(operation(current, '/api/sessions/{sessionId}', 'get'));
    const getSessionParameters = getSession.parameters as JsonObject[];
    expect(getSessionParameters[0]?.name).toBe('sessionId');
    if (getSessionParameters[0]) getSessionParameters[0].name = 'id';
    expect(getSession).toEqual(operation(previous, '/api/sessions/{id}', 'get'));

    const listGroups = structuredClone(operation(current, '/api/sessions/{sessionId}/groups', 'get'));
    const listGroupsOk = responseMap(listGroups)['200'] as JsonObject;
    expect(listGroupsOk.content).toEqual({
      'application/json': {
        schema: { type: 'array', items: { $ref: '#/components/schemas/SessionGroupSummaryDto' } },
      },
    });
    delete listGroupsOk.content;
    expect(listGroups).toEqual(operation(previous, '/api/sessions/{sessionId}/groups', 'get'));

    const listContactsPrevious = structuredClone(
      operation(previous, '/api/sessions/{sessionId}/contacts', 'get'),
    );
    expect(responseMap(listContactsPrevious)['404']).toEqual({ description: 'Session not found' });
    delete responseMap(listContactsPrevious)['404'];
    expect(operation(current, '/api/sessions/{sessionId}/contacts', 'get')).toEqual(listContactsPrevious);

    const createWebhook = structuredClone(operation(current, '/api/sessions/{sessionId}/webhooks', 'post'));
    expect(responseMap(createWebhook)['404']).toEqual({ description: 'Session not found' });
    delete responseMap(createWebhook)['404'];
    expect(createWebhook).toEqual(operation(previous, '/api/sessions/{sessionId}/webhooks', 'post'));

    const sendTextPrevious = structuredClone(
      operation(previous, '/api/sessions/{sessionId}/messages/send-text', 'post'),
    );
    expect(responseMap(sendTextPrevious)['404']).toEqual({ description: 'Session not found' });
    delete responseMap(sendTextPrevious)['404'];
    expect(operation(current, '/api/sessions/{sessionId}/messages/send-text', 'post')).toEqual(sendTextPrevious);
  });

  it('keeps Runtime-parsed payload schemas stable', () => {
    for (const name of [
      'ContactDto',
      'GroupInfoDto',
      'GroupSummaryDto',
      'MessageResponseDto',
      'SendTextMessageDto',
    ]) {
      expect(schema(current, name)).toEqual(schema(previous, name));
    }

    expect(schema(current, 'SessionGroupSummaryDto')).toMatchObject({
      required: ['id', 'name'],
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    });

    const session = structuredClone(schema(current, 'SessionResponseDto'));
    const engineLoaded = properties(session).engineLoaded as JsonObject;
    expect(engineLoaded.description).toContain('/sessions/:sessionId/stop');
    engineLoaded.description = String(engineLoaded.description).replace(':sessionId', ':id');
    expect(session).toEqual(schema(previous, 'SessionResponseDto'));
  });

  it('accepts authenticated-only health versions and additive webhook metadata', () => {
    const health = structuredClone(schema(current, 'HealthCheckResponseDto'));
    const healthVersion = properties(health).version as JsonObject;
    expect(health.required).toEqual(['status', 'timestamp']);
    expect(healthVersion.description).toContain('valid API key');
    healthVersion.description = (properties(schema(previous, 'HealthCheckResponseDto')).version as JsonObject).description;
    health.required = ['status', 'timestamp', 'version'];
    expect(health).toEqual(schema(previous, 'HealthCheckResponseDto'));

    for (const name of ['CreateWebhookDto', 'UpdateWebhookDto']) {
      const webhook = structuredClone(schema(current, name));
      const filters = properties(webhook).filters as JsonObject;
      expect(filters.allOf).toEqual([{ $ref: '#/components/schemas/WebhookFiltersDto' }]);
      delete filters.allOf;
      expect(webhook).toEqual(schema(previous, name));
    }

    const webhookResponse = structuredClone(schema(current, 'WebhookResponseDto'));
    const webhookProperties = properties(webhookResponse);
    const filters = webhookProperties.filters as JsonObject;
    expect(filters.allOf).toEqual([{ $ref: '#/components/schemas/WebhookFiltersDto' }]);
    delete filters.allOf;
    const events = webhookProperties.events as JsonObject;
    const eventItems = events.items as JsonObject;
    expect(eventItems.enum).toEqual(expect.arrayContaining([
      'message.received', 'message.ack', 'session.status',
    ]));
    delete eventItems.enum;
    expect(webhookResponse).toEqual(schema(previous, 'WebhookResponseDto'));
  });
});
