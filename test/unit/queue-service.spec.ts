import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

const connections: Array<{ on: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];

vi.mock('ioredis', () => ({
  default: class RedisMock {
    on = vi.fn();
    disconnect = vi.fn();
    status = 'ready';

    constructor() {
      connections.push(this);
    }
  },
}));

vi.mock('bullmq', () => ({
  Queue: class QueueMock {
    close = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../../src/core/config/runtime-config', () => ({
  runtimeConfig: () => ({ REDIS_URL: 'redis://redis.test:6379' }),
}));

describe('QueueService Redis connection logging', () => {
  afterEach(() => {
    connections.length = 0;
    vi.restoreAllMocks();
  });

  it('attaches structured error handlers without exposing the Redis URL', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { QueueService } = await import('../../src/core/queue/queue.service');
    const service = new QueueService();

    expect(connections).toHaveLength(2);
    for (const connection of connections) {
      expect(connection.on).toHaveBeenCalledWith('error', expect.any(Function));
    }
    const handler = connections[0]!.on.mock.calls.find(call => call[0] === 'error')?.[1] as (error: Error) => void;
    handler(Object.assign(new Error('connect ECONNREFUSED redis://secret@redis.test'), { code: 'ECONNREFUSED' }));

    expect(warn).toHaveBeenCalledWith({
      event: 'redis.connection.error', connection: 'queue', code: 'ECONNREFUSED',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('redis://');
    await service.onApplicationShutdown();
  });
});
