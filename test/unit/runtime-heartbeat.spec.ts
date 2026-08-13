import { describe, expect, it } from 'vitest';
import { runtimeHeartbeatKey, schedulerTickStateKey } from '../../src/core/queue/runtime-heartbeat';

describe('WA Runtime Redis keys', () => {
  it('uses the WA Runtime namespace for heartbeat and scheduler state', () => {
    expect(runtimeHeartbeatKey('worker')).toBe('wa-runtime:heartbeat:worker');
    expect(schedulerTickStateKey('messages')).toBe('wa-runtime:scheduler-tick:messages');
  });
});
