import type { SchedulerTickState } from '../../core/queue/runtime-heartbeat';

export interface SchedulerTickLogger {
  debug(message: unknown): void;
  warn(message: unknown): void;
  error(message: unknown): void;
}

export interface IsolatedSchedulerTickOptions {
  name: string;
  intervalMs: number;
  timeoutMs: number;
  maxBackoffMs: number;
  operation: () => Promise<void>;
  report: (state: SchedulerTickState) => Promise<void>;
  logger: SchedulerTickLogger;
}

export type SchedulerTickOutcome = 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED_OVERLAP';

export class IsolatedSchedulerTick {
  private running = false;
  private stopped = true;
  private timedOut = false;
  private consecutiveFailures = 0;
  private lastStartedAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastDurationMs: number | null = null;
  private nextRunAt: string | null = null;
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<SchedulerTickOutcome> | undefined;

  constructor(private readonly options: IsolatedSchedulerTickOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(graceMs = 10_000): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRunAt = null;
    if (!this.activeRun) return;
    let settled = false;
    await new Promise<void>(resolve => {
      const grace = setTimeout(resolve, graceMs);
      void this.activeRun!.then(
        () => { settled = true; clearTimeout(grace); resolve(); },
        () => { settled = true; clearTimeout(grace); resolve(); },
      );
    });
    if (!settled) {
      this.options.logger.warn({
        event: 'scheduler.tick.shutdown_incomplete',
        tick: this.options.name,
        graceMs,
      });
    }
  }

  async execute(): Promise<SchedulerTickOutcome> {
    if (this.running) {
      this.options.logger.warn({ event: 'scheduler.tick.overlap_skipped', tick: this.options.name });
      return 'SKIPPED_OVERLAP';
    }

    this.running = true;
    this.timedOut = false;
    const startedAtMs = Date.now();
    this.lastStartedAt = new Date(startedAtMs).toISOString();
    this.nextRunAt = null;
    await this.report();
    const timeout = setTimeout(() => {
      this.timedOut = true;
      this.options.logger.error({
        event: 'scheduler.tick.timed_out',
        tick: this.options.name,
        timeoutMs: this.options.timeoutMs,
      });
      void this.report();
    }, this.options.timeoutMs);
    timeout.unref();

    let error: unknown;
    try {
      await this.options.operation();
    } catch (caught) {
      error = caught;
    } finally {
      clearTimeout(timeout);
    }

    const completedAtMs = Date.now();
    this.lastDurationMs = completedAtMs - startedAtMs;
    this.running = false;
    let outcome: SchedulerTickOutcome;
    if (error || this.timedOut) {
      this.consecutiveFailures += 1;
      this.lastFailureAt = new Date(completedAtMs).toISOString();
      outcome = this.timedOut ? 'TIMED_OUT' : 'FAILED';
      this.options.logger.error({
        event: 'scheduler.tick.failed',
        tick: this.options.name,
        outcome,
        durationMs: this.lastDurationMs,
        consecutiveFailures: this.consecutiveFailures,
        error,
      });
    } else {
      this.consecutiveFailures = 0;
      this.lastSuccessAt = new Date(completedAtMs).toISOString();
      outcome = 'SUCCEEDED';
      this.options.logger.debug({
        event: 'scheduler.tick.completed',
        tick: this.options.name,
        durationMs: this.lastDurationMs,
      });
    }

    const delayMs = this.nextDelayMs();
    this.nextRunAt = new Date(completedAtMs + delayMs).toISOString();
    await this.report();
    return outcome;
  }

  snapshot(): SchedulerTickState {
    return {
      name: this.options.name,
      running: this.running,
      timedOut: this.timedOut,
      consecutiveFailures: this.consecutiveFailures,
      lastStartedAt: this.lastStartedAt,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastDurationMs: this.lastDurationMs,
      nextRunAt: this.nextRunAt,
    };
  }

  private nextDelayMs(): number {
    if (this.consecutiveFailures === 0) return this.options.intervalMs;
    return Math.min(
      this.options.maxBackoffMs,
      this.options.intervalMs * 2 ** Math.min(this.consecutiveFailures, 10),
    );
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const activeRun = this.execute();
      this.activeRun = activeRun;
      void activeRun
        .catch(error => this.options.logger.error({
          event: 'scheduler.tick.runner_failed',
          tick: this.options.name,
          error,
        }))
        .finally(() => {
          if (this.activeRun === activeRun) this.activeRun = undefined;
          if (!this.stopped) {
            const nextAt = this.nextRunAt ? Date.parse(this.nextRunAt) : Date.now() + this.options.intervalMs;
            this.schedule(Math.max(0, nextAt - Date.now()));
          }
        });
    }, delayMs);
    this.timer.unref();
  }

  private async report(): Promise<void> {
    try {
      await this.options.report(this.snapshot());
    } catch (error) {
      this.options.logger.error({
        event: 'scheduler.tick.telemetry_failed',
        tick: this.options.name,
        error,
      });
    }
  }
}
