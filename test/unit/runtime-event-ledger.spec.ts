import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runtimeEventLedgerRecord } from '../../src/modules/webhooks/runtime-event.repository';

describe('runtime event ledger payload', () => {
  it('keeps the message body in its inbox owner and stores only audit metadata in the ledger', () => {
    const record = runtimeEventLedgerRecord({
      eventId: 'event-1',
      sourceEventType: 'message.received',
      eventType: 'message.received',
      eventVersion: 1,
      sessionId: 'session-1',
      occurredAt: new Date('2026-08-21T00:00:00.000Z'),
      payload: {
        messageId: 'message-1',
        groupId: 'group-1',
        senderId: 'sender-1',
        body: 'xin chào 👋',
        messageType: 'text',
        fromMe: false,
        isGroup: true,
      },
    });

    expect(record).toEqual({
      eventVersion: 2,
      payload: {
        messageId: 'message-1',
        groupId: 'group-1',
        senderId: 'sender-1',
        messageType: 'text',
        fromMe: false,
        isGroup: true,
        bodyBytes: Buffer.byteLength('xin chào 👋', 'utf8'),
        bodySha256: createHash('sha256').update('xin chào 👋').digest('hex'),
      },
    });
    expect(record.payload).not.toHaveProperty('body');
  });

  it('does not rewrite already compact event families', () => {
    const payload = { status: 'ready' };
    expect(runtimeEventLedgerRecord({
      eventId: 'event-2',
      sourceEventType: 'session.status',
      eventType: 'session.status.changed',
      eventVersion: 1,
      sessionId: 'session-1',
      occurredAt: new Date('2026-08-21T00:00:00.000Z'),
      payload,
    })).toEqual({ eventVersion: 1, payload });
  });

  it('retains the v1 body while the rollout flag is disabled', () => {
    const event = {
      eventId: 'event-3',
      sourceEventType: 'message.received',
      eventType: 'message.received',
      eventVersion: 1 as const,
      sessionId: 'session-1',
      occurredAt: new Date('2026-08-21T00:00:00.000Z'),
      payload: { messageId: 'message-3', body: 'rollback-safe' },
    };
    expect(runtimeEventLedgerRecord(event, false)).toEqual({
      eventVersion: 1,
      payload: event.payload,
    });
  });
});
