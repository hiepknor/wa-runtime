import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueService } from '../../src/core/queue/queue.service';

describe('distributed outbound session lock', () => {
  let firstQueue: QueueService;
  let secondQueue: QueueService;

  beforeAll(() => {
    firstQueue = new QueueService();
    secondQueue = new QueueService();
  });

  afterAll(async () => {
    await Promise.all([firstQueue.onApplicationShutdown(), secondQueue.onApplicationShutdown()]);
  });

  it('serializes work for one session across independent Redis connections', async () => {
    const sessionId = randomUUID();
    const order: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const operation = (name: string) => async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(`${name}:start`);
      await new Promise(resolve => setTimeout(resolve, 75));
      order.push(`${name}:end`);
      active -= 1;
    };

    await Promise.all([
      firstQueue.withOutboundSessionLock(sessionId, async () => undefined, operation('first')),
      secondQueue.withOutboundSessionLock(sessionId, async () => undefined, operation('second')),
    ]);

    expect(maximumActive).toBe(1);
    expect(order).toSatisfy(value =>
      value.join(',') === 'first:start,first:end,second:start,second:end'
      || value.join(',') === 'second:start,second:end,first:start,first:end');
  });
});
