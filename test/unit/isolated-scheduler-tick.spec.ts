import { describe, expect, it, vi } from 'vitest';
import { IsolatedSchedulerTick } from '../../src/modules/orchestration/isolated-scheduler-tick';

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const create = (operation: () => Promise<void>, timeoutMs = 100) => {
  const reports: unknown[] = [];
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const tick = new IsolatedSchedulerTick({
    name: 'test',
    intervalMs: 1_000,
    timeoutMs,
    maxBackoffMs: 8_000,
    operation,
    report: async state => { reports.push(state); },
    logger,
  });
  return { tick, reports, logger };
};

describe('IsolatedSchedulerTick', () => {
  it('records success and resets failure backoff state', async () => {
    const { tick, reports } = create(vi.fn().mockResolvedValue(undefined));

    await expect(tick.execute()).resolves.toBe('SUCCEEDED');

    expect(tick.snapshot()).toMatchObject({
      running: false,
      timedOut: false,
      consecutiveFailures: 0,
    });
    expect(tick.snapshot().lastSuccessAt).not.toBeNull();
    expect(reports.length).toBeGreaterThanOrEqual(2);
  });

  it('does not overlap an operation that is still running', async () => {
    const work = deferred<void>();
    const { tick, logger } = create(() => work.promise);
    const first = tick.execute();

    await expect(tick.execute()).resolves.toBe('SKIPPED_OVERLAP');
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'scheduler.tick.overlap_skipped',
    }));
    work.resolve();
    await expect(first).resolves.toBe('SUCCEEDED');
  });

  it('marks timeout but keeps the no-overlap guard until the operation settles', async () => {
    vi.useFakeTimers();
    try {
      const work = deferred<void>();
      const { tick, logger } = create(() => work.promise, 100);
      const first = tick.execute();
      await vi.advanceTimersByTimeAsync(101);

      expect(tick.snapshot()).toMatchObject({ running: true, timedOut: true });
      await expect(tick.execute()).resolves.toBe('SKIPPED_OVERLAP');
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
        event: 'scheduler.tick.timed_out',
      }));
      work.resolve();
      await expect(first).resolves.toBe('TIMED_OUT');
      expect(tick.snapshot()).toMatchObject({ running: false, consecutiveFailures: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies bounded exponential backoff and recovers after success', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockResolvedValue(undefined);
    const { tick } = create(operation);

    await expect(tick.execute()).resolves.toBe('FAILED');
    const firstDelay = Date.parse(tick.snapshot().nextRunAt!) - Date.now();
    await expect(tick.execute()).resolves.toBe('FAILED');
    const secondDelay = Date.parse(tick.snapshot().nextRunAt!) - Date.now();
    await expect(tick.execute()).resolves.toBe('SUCCEEDED');

    expect(firstDelay).toBeGreaterThanOrEqual(1_900);
    expect(secondDelay).toBeGreaterThanOrEqual(3_900);
    expect(tick.snapshot().consecutiveFailures).toBe(0);
  });

  it('lets another tick progress while one tick is blocked', async () => {
    const blocked = deferred<void>();
    const first = create(() => blocked.promise).tick;
    const secondOperation = vi.fn().mockResolvedValue(undefined);
    const second = create(secondOperation).tick;

    const firstRun = first.execute();
    await expect(second.execute()).resolves.toBe('SUCCEEDED');
    expect(secondOperation).toHaveBeenCalledOnce();
    expect(first.snapshot().running).toBe(true);

    blocked.resolve();
    await expect(firstRun).resolves.toBe('SUCCEEDED');
  });

  it('does not let telemetry failure change the work outcome', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const tick = new IsolatedSchedulerTick({
      name: 'test', intervalMs: 1000, timeoutMs: 1000, maxBackoffMs: 8000,
      operation: vi.fn().mockResolvedValue(undefined),
      report: vi.fn().mockRejectedValue(new Error('redis unavailable')),
      logger,
    });

    await expect(tick.execute()).resolves.toBe('SUCCEEDED');
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'scheduler.tick.telemetry_failed',
    }));
  });

  it('waits for an active scheduled run during graceful shutdown', async () => {
    vi.useFakeTimers();
    try {
      const work = deferred<void>();
      const { tick } = create(() => work.promise, 10_000);
      tick.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(tick.snapshot().running).toBe(true);

      let stopped = false;
      const stopping = tick.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      work.resolve();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
