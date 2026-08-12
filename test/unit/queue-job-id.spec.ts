import { describe, expect, it } from 'vitest';
import { stableQueueJobId } from '../../src/core/queue/queue-job-id';

describe('stableQueueJobId', () => {
  it('is deterministic and does not collapse sanitized values', () => {
    expect(stableQueueJobId('webhook', 'delivery:a')).toBe(stableQueueJobId('webhook', 'delivery:a'));
    expect(stableQueueJobId('webhook', 'delivery:a')).not.toBe(stableQueueJobId('webhook', 'delivery/a'));
    expect(stableQueueJobId('webhook', 'delivery:a')).toMatch(/^webhook-[a-f0-9]{64}$/);
  });
});
