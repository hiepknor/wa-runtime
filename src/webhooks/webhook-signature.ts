import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyOpenWASignature(rawBody: Buffer, supplied: string | undefined, secret: string): boolean {
  if (!supplied) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}
