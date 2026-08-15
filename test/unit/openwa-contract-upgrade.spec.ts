import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface OpenWAContract {
  info: { version: string };
  paths: Record<string, unknown>;
  components: { schemas: Record<string, unknown> };
}

const readContract = (release: string): OpenWAContract => JSON.parse(readFileSync(
  resolve(process.cwd(), 'contracts', 'openwa', release, 'openapi.json'),
  'utf8',
)) as OpenWAContract;

const usedPaths = [
  '/api/health',
  '/api/sessions',
  '/api/sessions/{id}',
  '/api/sessions/{sessionId}/groups',
  '/api/sessions/{sessionId}/groups/{groupId}',
  '/api/sessions/{sessionId}/contacts',
  '/api/sessions/{sessionId}/webhooks',
  '/api/sessions/{sessionId}/webhooks/{id}',
  '/api/sessions/{sessionId}/messages/send-text',
];

const unchangedSchemas = [
  'ContactDto',
  'CreateWebhookDto',
  'GroupInfoDto',
  'GroupSummaryDto',
  'HealthCheckResponseDto',
  'MessageResponseDto',
  'SessionResponseDto',
  'UpdateWebhookDto',
  'WebhookResponseDto',
];

describe('OpenWA 0.18.0 contract review', () => {
  const previous = readContract('0.16.0');
  const current = readContract('0.18.0');

  it('pins the expected upstream artifact and keeps every Runtime-used operation stable', () => {
    expect(current.info.version).toBe('0.18.0');
    for (const path of usedPaths) expect(current.paths[path]).toEqual(previous.paths[path]);
  });

  it('keeps response schemas stable and changes send-text only by an optional quote field', () => {
    for (const schema of unchangedSchemas) {
      expect(current.components.schemas[schema]).toEqual(previous.components.schemas[schema]);
    }
    const previousSend = previous.components.schemas.SendTextMessageDto as {
      properties: Record<string, unknown>;
    };
    const currentSend = structuredClone(current.components.schemas.SendTextMessageDto) as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(currentSend.properties.quotedMessageId).toMatchObject({ type: 'string' });
    delete currentSend.properties.quotedMessageId;
    expect(currentSend).toEqual(previousSend);
    expect(currentSend.required).not.toContain('quotedMessageId');
  });
});
