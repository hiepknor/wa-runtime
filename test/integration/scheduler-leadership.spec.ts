import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../src/core/database/database.service';
import {
  SchedulerLeadershipService,
  SchedulerLeadershipUnavailableError,
} from '../../src/modules/orchestration/scheduler-leadership.service';

describe('scheduler leadership', () => {
  const databases: DatabaseService[] = [];
  const leaders: SchedulerLeadershipService[] = [];

  afterEach(async () => {
    await Promise.allSettled(leaders.map(leader => leader.release()));
    await Promise.allSettled(databases.map(database => database.onApplicationShutdown()));
    leaders.length = 0;
    databases.length = 0;
  });

  const createLeader = (): SchedulerLeadershipService => {
    const database = new DatabaseService();
    const leader = new SchedulerLeadershipService(database);
    databases.push(database);
    leaders.push(leader);
    return leader;
  };

  it('allows exactly one owner and transfers ownership after release', async () => {
    const first = createLeader();
    const second = createLeader();

    await first.acquire();
    await expect(second.acquire()).rejects.toBeInstanceOf(SchedulerLeadershipUnavailableError);

    await first.release();
    await expect(second.acquire()).resolves.toBeUndefined();
  });
});
