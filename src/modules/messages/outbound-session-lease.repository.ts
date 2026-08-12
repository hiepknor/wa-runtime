import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';

@Injectable()
export class OutboundSessionLeaseRepository {
  constructor(private readonly database: DatabaseService) {}

  async tryAcquire(
    sessionId: string,
    messageJobId: string,
    leaseToken: string,
    ttlMs: number,
  ): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO outbound_session_leases
         (session_id, lease_token, holder_message_job_id, lease_expires_at)
       VALUES ($1, $3::uuid, $2::uuid, now() + $4 * interval '1 millisecond')
       ON CONFLICT (session_id) DO UPDATE SET
         lease_token = EXCLUDED.lease_token,
         holder_message_job_id = EXCLUDED.holder_message_job_id,
         lease_expires_at = EXCLUDED.lease_expires_at,
         acquired_at = now(), updated_at = now()
       WHERE outbound_session_leases.lease_expires_at < now()
         OR (outbound_session_leases.holder_message_job_id = $2::uuid
           AND outbound_session_leases.lease_token = $3::uuid)
       RETURNING 1`,
      [sessionId, messageJobId, leaseToken, ttlMs],
    );
    return result.rowCount === 1;
  }

  async renew(sessionId: string, messageJobId: string, leaseToken: string, ttlMs: number): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE outbound_session_leases
       SET lease_expires_at = now() + $4 * interval '1 millisecond', updated_at = now()
       WHERE session_id = $1 AND holder_message_job_id = $2::uuid AND lease_token = $3::uuid
         AND lease_expires_at > now()`,
      [sessionId, messageJobId, leaseToken, ttlMs],
    );
    return result.rowCount === 1;
  }

  async release(sessionId: string, messageJobId: string, leaseToken: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM outbound_session_leases
       WHERE session_id = $1 AND holder_message_job_id = $2::uuid AND lease_token = $3::uuid`,
      [sessionId, messageJobId, leaseToken],
    );
    return result.rowCount === 1;
  }
}
