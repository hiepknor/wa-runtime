import type { PoolClient } from 'pg';

export async function acquireSessionTransactionLock(
  client: PoolClient,
  namespace: string,
  sessionId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended($1 || ':' || $2, 0)
     )`,
    [namespace, sessionId],
  );
}
