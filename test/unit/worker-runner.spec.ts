import { describe, expect, it, vi } from 'vitest';
import {
  CAMPAIGN_QUEUE,
  GATEWAY_SYNC_QUEUE,
  MESSAGE_SEND_QUEUE,
  WEBHOOK_QUEUE,
} from '../../src/core/queue/queue.constants';

const workerRecords = vi.hoisted(() => [] as Array<{
  name: string;
  options: { concurrency: number };
  close: ReturnType<typeof vi.fn>;
}>);
const redisDisconnect = vi.hoisted(() => vi.fn());

vi.mock('bullmq', () => ({
  Worker: class WorkerMock {
    readonly close = vi.fn().mockResolvedValue(undefined);
    readonly on = vi.fn();

    constructor(
      readonly name: string,
      _processor: unknown,
      readonly options: { concurrency: number },
    ) {
      workerRecords.push({ name, options, close: this.close });
    }
  },
}));

vi.mock('ioredis', () => ({
  default: class RedisMock {
    disconnect = redisDisconnect;
  },
}));

vi.mock('../../src/core/config/runtime-config', () => ({
  runtimeConfig: () => ({
    REDIS_URL: 'redis://redis.test:6379',
    MESSAGE_WORKER_CONCURRENCY: 3,
    WEBHOOK_WORKER_CONCURRENCY: 11,
    GATEWAY_WORKER_CONCURRENCY: 4,
    CAMPAIGN_WORKER_CONCURRENCY: 5,
  }),
}));

import { WorkerRunnerService } from '../../src/modules/orchestration/worker-runner.service';

describe('WorkerRunnerService', () => {
  it('uses the validated per-queue concurrency configuration', async () => {
    workerRecords.length = 0;
    redisDisconnect.mockReset();
    const queues = { publishHeartbeat: vi.fn().mockResolvedValue(undefined) };
    const processor = { process: vi.fn() };
    const runner = new WorkerRunnerService(
      processor as never,
      processor as never,
      processor as never,
      processor as never,
      queues as never,
    );

    const running = runner.run();
    await vi.waitFor(() => expect(queues.publishHeartbeat).toHaveBeenCalledWith('worker'));
    await new Promise<void>(resolve => setImmediate(resolve));
    process.emit('SIGTERM');
    await running;

    expect(workerRecords.map(worker => [worker.name, worker.options.concurrency])).toEqual([
      [MESSAGE_SEND_QUEUE, 3],
      [WEBHOOK_QUEUE, 11],
      [GATEWAY_SYNC_QUEUE, 4],
      [CAMPAIGN_QUEUE, 5],
    ]);
    expect(workerRecords.every(worker => worker.close.mock.calls.length === 1)).toBe(true);
    expect(redisDisconnect).toHaveBeenCalledOnce();
  });
});
