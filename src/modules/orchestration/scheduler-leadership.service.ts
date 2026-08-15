import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../core/database/database.service';

const schedulerLeadershipKey = 'wa-runtime:scheduler';

export class SchedulerLeadershipUnavailableError extends Error {
  constructor() {
    super('Scheduler leadership is already held by another runtime instance');
    this.name = 'SchedulerLeadershipUnavailableError';
  }
}

export class SchedulerLeadershipLostError extends Error {
  constructor(cause: Error) {
    super('Scheduler leadership database connection was lost', { cause });
    this.name = 'SchedulerLeadershipLostError';
  }
}

@Injectable()
export class SchedulerLeadershipService {
  private client: PoolClient | undefined;
  private leadershipLost = false;
  private loss: Promise<Error> = new Promise(() => undefined);
  private resolveLoss: ((error: Error) => void) | undefined;

  constructor(private readonly database: DatabaseService) {}

  async acquire(): Promise<void> {
    if (this.client) return;
    const client = await this.database.pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS acquired',
        [schedulerLeadershipKey],
      );
      if (!result.rows[0]?.acquired) throw new SchedulerLeadershipUnavailableError();

      this.leadershipLost = false;
      this.loss = new Promise<Error>(resolve => { this.resolveLoss = resolve; });
      this.client = client;
      client.on('error', this.onClientError);
    } catch (error) {
      client.release(error instanceof Error ? error : true);
      throw error;
    }
  }

  waitForLoss(): Promise<Error> {
    return this.loss;
  }

  async release(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = undefined;
    client.off('error', this.onClientError);
    try {
      if (!this.leadershipLost) {
        await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [schedulerLeadershipKey]);
      }
    } finally {
      client.release(this.leadershipLost);
      this.resolveLoss = undefined;
    }
  }

  private readonly onClientError = (cause: Error): void => {
    if (!this.client || this.leadershipLost) return;
    this.leadershipLost = true;
    this.resolveLoss?.(new SchedulerLeadershipLostError(cause));
  };
}
