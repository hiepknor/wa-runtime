import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../../src/core/database/database.service';
import {
  SchedulerLeadershipLostError,
  SchedulerLeadershipService,
} from '../../src/modules/orchestration/scheduler-leadership.service';

describe('SchedulerLeadershipService', () => {
  it('reports loss of the dedicated lock connection and destroys it on release', async () => {
    const client = new EventEmitter() as EventEmitter & Pick<PoolClient, 'on' | 'off'> & {
      query: ReturnType<typeof vi.fn>;
      release: ReturnType<typeof vi.fn>;
    };
    client.query = vi.fn().mockResolvedValue({ rows: [{ acquired: true }] });
    client.release = vi.fn();
    const database = {
      pool: { connect: vi.fn().mockResolvedValue(client) },
    } as unknown as DatabaseService;
    const leadership = new SchedulerLeadershipService(database);

    await leadership.acquire();
    const lost = leadership.waitForLoss();
    client.emit('error', new Error('connection closed'));

    await expect(lost).resolves.toBeInstanceOf(SchedulerLeadershipLostError);
    await leadership.release();
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(true);
  });
});
