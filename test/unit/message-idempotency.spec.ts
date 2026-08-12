import { describe, expect, it } from 'vitest';
import { messageRequestHash } from '../../src/modules/messages/message-idempotency';

const intent = {
  sessionId: 'session-1',
  recipientId: 'group@g.us',
  text: 'hello',
  scheduledAt: null,
  dryRun: true,
};

describe('messageRequestHash', () => {
  it('is stable for the same intent', () => {
    expect(messageRequestHash(intent)).toBe(messageRequestHash({ ...intent }));
  });

  it('changes when an idempotent request changes meaning', () => {
    expect(messageRequestHash(intent)).not.toBe(messageRequestHash({ ...intent, text: 'different' }));
    expect(messageRequestHash(intent)).not.toBe(messageRequestHash({ ...intent, dryRun: false }));
  });
});
