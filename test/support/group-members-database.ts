import { Pool } from 'pg';

export const INTEGRATION_SESSION_ID = '00000000-0000-4000-8000-000000000001';
export const DISALLOWED_SESSION_ID = '00000000-0000-4000-8000-000000000002';
export const INTEGRATION_GROUP_ID = '120363000000000000@g.us';

export function integrationPool(): Pool {
  return new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
}

export async function resetIntegrationDatabase(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE sync_runs, gateway_sessions RESTART IDENTITY CASCADE');
}

export async function seedSendableGroup(pool: Pool, sessionId = INTEGRATION_SESSION_ID): Promise<void> {
  await pool.query(
    `INSERT INTO gateway_sessions
       (id, name, status, engine_loaded, restriction, gateway_created_at, gateway_updated_at)
     VALUES ($1, 'Integration session', 'ready', true, NULL, now(), now())`,
    [sessionId],
  );
  await pool.query(
    `INSERT INTO gateway_groups
       (session_id, id, name, is_admin, is_read_only, is_announce, details_synced_at,
        send_capability, send_capability_reason, capability_checked_at)
     VALUES ($1, $2, 'Integration group', true, false, false, now(), 'ALLOWED', 'SEND_ALLOWED', now())`,
    [sessionId, INTEGRATION_GROUP_ID],
  );
}
