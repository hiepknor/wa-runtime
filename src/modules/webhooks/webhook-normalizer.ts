import type { OpenWAWebhookEnvelope } from './webhook.repository';

export interface RuntimeEvent {
  eventId: string;
  sourceEventType: string;
  eventType: string;
  eventVersion: 1;
  sessionId: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

const dateFrom = (value: unknown, fallback: string): Date => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 10_000_000_000 ? value * 1000 : value);
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) return parsed;
  }
  return new Date(fallback);
};

const text = (value: unknown): string => typeof value === 'string' ? value : '';

export function normalizeOpenWAWebhook(envelope: OpenWAWebhookEnvelope): RuntimeEvent {
  const base = {
    eventId: envelope.idempotencyKey,
    sourceEventType: envelope.event,
    eventVersion: 1 as const,
    sessionId: envelope.sessionId,
    occurredAt: dateFrom(envelope.data.timestamp, envelope.timestamp),
  };

  if (envelope.event === 'message.received') {
    const groupId = text(envelope.data.chatId || envelope.data.from);
    return {
      ...base,
      eventType: 'message.received',
      payload: {
        messageId: text(envelope.data.id), groupId,
        senderId: text(envelope.data.author || envelope.data.from),
        body: text(envelope.data.body),
        messageType: text(envelope.data.type) || 'unknown',
        fromMe: envelope.data.fromMe === true,
        isGroup: envelope.data.isGroup === true || groupId.endsWith('@g.us'),
      },
    };
  }

  if (envelope.event === 'message.ack' || envelope.event === 'message.sent' || envelope.event === 'message.failed') {
    return {
      ...base,
      eventType: envelope.event,
      payload: {
        messageId: text(envelope.data.messageId || envelope.data.id),
        groupId: text(envelope.data.chatId) || null,
        deliveryStatus: text(envelope.data.status || envelope.data.ack) || null,
      },
    };
  }

  if (envelope.event === 'session.status') {
    return { ...base, eventType: 'session.status.changed', payload: { status: text(envelope.data.status) || 'unknown' } };
  }

  if (envelope.event === 'session.restriction') {
    return {
      ...base,
      eventType: 'session.restriction.changed',
      payload: {
        active: envelope.data.active === true,
        kind: text(envelope.data.kind) || null,
        code: text(envelope.data.code) || null,
        expiresAt: text(envelope.data.expiresAt) || null,
      },
    };
  }

  if (['group.join', 'group.leave', 'group.update'].includes(envelope.event)) {
    return {
      ...base,
      eventType: envelope.event,
      payload: {
        groupId: text(envelope.data.groupId),
        participantIds: Array.isArray(envelope.data.participantIds) ? envelope.data.participantIds : [],
        changes: typeof envelope.data.changes === 'object' && envelope.data.changes !== null
          ? envelope.data.changes
          : null,
      },
    };
  }

  return { ...base, eventType: `gateway.${envelope.event}`, payload: envelope.data };
}
