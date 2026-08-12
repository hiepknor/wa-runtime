export const RUNTIME_HEARTBEAT_INTERVAL_MS = 5_000;
export const RUNTIME_HEARTBEAT_TTL_SECONDS = 15;

export type RuntimeProcessName = 'worker' | 'scheduler';

export const runtimeHeartbeatKey = (processName: RuntimeProcessName): string =>
  `automation-runtime:heartbeat:${processName}`;
