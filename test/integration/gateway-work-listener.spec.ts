import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { GatewayWorkListenerService } from '../../src/modules/orchestration/gateway-work-listener.service';
import { integrationPool } from '../support/integration-database';

describe('PostgreSQL gateway work listener', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = integrationPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('wakes immediately for the fixed, identity-free notification payload', async () => {
    const listener = new GatewayWorkListenerService();
    const wake = vi.fn().mockResolvedValue(undefined);
    await listener.start(wake);
    expect(wake).toHaveBeenCalledTimes(1);

    await pool.query(`SELECT pg_notify('wa_runtime_gateway_work', 'ignored-payload')`);
    await pool.query(`SELECT pg_notify('wa_runtime_gateway_work', 'group-reconciliation')`);
    await expect.poll(() => wake.mock.calls.length, { timeout: 2_000 }).toBe(2);

    await listener.stop();
  });
});
