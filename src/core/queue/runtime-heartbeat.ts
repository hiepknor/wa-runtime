export const RUNTIME_HEARTBEAT_INTERVAL_MS = 5_000;
export const RUNTIME_HEARTBEAT_TTL_SECONDS = 15;

export type RuntimeProcessName = 'worker' | 'scheduler';

export interface SchedulerTickState {
  name: string;
  running: boolean;
  timedOut: boolean;
  consecutiveFailures: number;
  lastStartedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastDurationMs: number | null;
  nextRunAt: string | null;
}

export const runtimeHeartbeatKey = (processName: RuntimeProcessName): string =>
  `wa-runtime:heartbeat:${processName}`;

export const schedulerTickStateKey = (tick: string): string =>
  `wa-runtime:scheduler-tick:${tick}`;
