import { createHash } from 'node:crypto';

export function stableQueueJobId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex')}`;
}
