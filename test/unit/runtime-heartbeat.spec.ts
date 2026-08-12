import { describe, expect, it } from 'vitest';
import {
  legacyRuntimeHeartbeatKey,
  legacySchedulerTickStateKey,
  runtimeHeartbeatKey,
  schedulerTickStateKey,
} from '../../src/core/queue/runtime-heartbeat';

describe('WA Runtime Redis key migration', () => {
  it('uses the WA Runtime namespace for current heartbeat and scheduler state', () => {
    expect(runtimeHeartbeatKey('worker')).toBe('wa-runtime:heartbeat:worker');
    expect(schedulerTickStateKey('messages')).toBe('wa-runtime:scheduler-tick:messages');
  });

  it('keeps explicit legacy keys during the rolling-deployment window', () => {
    expect(legacyRuntimeHeartbeatKey('scheduler')).toBe('automation-runtime:heartbeat:scheduler');
    expect(legacySchedulerTickStateKey('messages')).toBe('automation-runtime:scheduler-tick:messages');
  });
});
