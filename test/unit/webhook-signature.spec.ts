import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyOpenWASignature } from '../../src/modules/webhooks/webhook-signature';

describe('verifyOpenWASignature', () => {
  it('accepts the HMAC over the exact raw body', () => {
    const raw = Buffer.from('{"event":"test"}');
    const secret = 'a'.repeat(32);
    const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    expect(verifyOpenWASignature(raw, signature, secret)).toBe(true);
  });

  it('rejects missing and altered signatures without throwing', () => {
    const raw = Buffer.from('{}');
    const secret = 'a'.repeat(32);
    expect(verifyOpenWASignature(raw, undefined, secret)).toBe(false);
    expect(verifyOpenWASignature(raw, 'sha256=bad', secret)).toBe(false);
  });
});
