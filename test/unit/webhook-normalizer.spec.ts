import { describe, expect, it } from 'vitest';
import { normalizeOpenWAWebhook } from '../../src/modules/webhooks/webhook-normalizer';

describe('normalizeOpenWAWebhook', () => {
  it('normalizes an inbound group message without exposing the upstream payload', () => {
    const event = normalizeOpenWAWebhook({
      event: 'message.received',
      timestamp: '2026-08-11T05:00:00.000Z',
      sessionId: 'session-1',
      idempotencyKey: 'delivery-1:message.received',
      deliveryId: 'delivery-1',
      data: {
        id: 'message-1', chatId: '120363@g.us', from: '120363@g.us', author: '8497@c.us',
        body: 'hello', type: 'text', timestamp: 1786424400, fromMe: false, isGroup: true,
        contact: { pushName: 'must not leak' },
      },
    });

    expect(event).toMatchObject({
      eventId: 'delivery-1:message.received', eventType: 'message.received', eventVersion: 1,
      sessionId: 'session-1',
      payload: {
        messageId: 'message-1', groupId: '120363@g.us', senderId: '8497@c.us',
        body: 'hello', messageType: 'text', fromMe: false, isGroup: true,
      },
    });
    expect(event.payload).not.toHaveProperty('contact');
  });

  it('versions and renames a gateway session event', () => {
    const event = normalizeOpenWAWebhook({
      event: 'session.status', timestamp: '2026-08-11T05:00:00.000Z', sessionId: 'session-1',
      idempotencyKey: 'status-1', deliveryId: 'delivery-1', data: { status: 'ready' },
    });
    expect(event).toMatchObject({ eventType: 'session.status.changed', eventVersion: 1, payload: { status: 'ready' } });
  });

  it('normalizes account restrictions and lifts', () => {
    const restricted = normalizeOpenWAWebhook({
      event: 'session.restriction', timestamp: '2026-08-11T05:00:00.000Z', sessionId: 'session-1',
      idempotencyKey: 'restriction-1', deliveryId: 'delivery-1',
      data: { active: true, kind: 'reachout_timelock', code: 'BIZ_QUALITY', expiresAt: '2026-08-12T05:00:00.000Z' },
    });
    const lifted = normalizeOpenWAWebhook({
      event: 'session.restriction', timestamp: '2026-08-11T06:00:00.000Z', sessionId: 'session-1',
      idempotencyKey: 'restriction-2', deliveryId: 'delivery-2',
      data: { active: false, kind: 'reachout_timelock', code: 'BIZ_QUALITY', expiresAt: null },
    });

    expect(restricted).toMatchObject({
      eventType: 'session.restriction.changed',
      payload: { active: true, kind: 'reachout_timelock', code: 'BIZ_QUALITY' },
    });
    expect(lifted).toMatchObject({ eventType: 'session.restriction.changed', payload: { active: false } });
  });

  it('keeps only capability-relevant group event fields', () => {
    const event = normalizeOpenWAWebhook({
      event: 'group.update', timestamp: '2026-08-11T05:00:00.000Z', sessionId: 'session-1',
      idempotencyKey: 'group-1', deliveryId: 'delivery-1',
      data: { groupId: '120363@g.us', participantIds: [], changes: { announce: true }, ignored: 'raw' },
    });
    expect(event).toMatchObject({
      eventType: 'group.update',
      payload: { groupId: '120363@g.us', participantIds: [], changes: { announce: true } },
    });
    expect(event.payload).not.toHaveProperty('ignored');
  });
});
