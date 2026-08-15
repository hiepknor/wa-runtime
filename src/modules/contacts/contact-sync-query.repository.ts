import { DatabaseService } from '../../core/database/database.service';

export class ContactSyncQueryRepository {
  constructor(private readonly database: DatabaseService) {}

  async listPeriodicSessionIds(allowedSessionIds: string[], limit: number): Promise<string[]> {
    const result = await this.database.query<{ id: string }>(
      `SELECT session.id FROM gateway_sessions session
       LEFT JOIN contact_sync_state state ON state.session_id = session.id
       WHERE session.id = ANY($1::text[]) AND session.status = 'ready' AND session.engine_loaded = true
         AND (state.session_id IS NULL OR state.next_attempt_at <= now())
         AND (state.lease_token IS NULL OR state.lease_expires_at < now())
       ORDER BY state.next_attempt_at NULLS FIRST, session.id LIMIT $2`,
      [allowedSessionIds, limit],
    );
    return result.rows.map(row => row.id);
  }

  async getCoverageMetrics(sessionId: string): Promise<Record<string, number>> {
    const result = await this.database.query<Record<string, string>>(
      `SELECT
         count(*)::text AS member_records,
         count(*) FILTER (WHERE member.contact_id IS NOT NULL)::text AS linked_records,
         count(*) FILTER (WHERE member.display_name IS NOT NULL)::text AS named_records,
         count(*) FILTER (WHERE identifier.identity_type = 'LID')::text AS lid_records,
         count(*) FILTER (WHERE identifier.identity_type = 'LID'
           AND member.display_name IS NOT NULL)::text AS named_lid_records,
         count(*) FILTER (WHERE identifier.identity_type = 'PHONE_JID')::text AS phone_jid_records,
         count(*) FILTER (WHERE identifier.identity_type = 'PHONE_JID'
           AND member.display_name IS NOT NULL)::text AS named_phone_jid_records,
         count(*) FILTER (WHERE member.display_name_source = 'OPENWA_CONTACT_NAME')::text AS contact_name_records,
         count(*) FILTER (WHERE member.display_name_source = 'GROUP_PARTICIPANT_NAME')::text AS participant_name_records,
         count(*) FILTER (WHERE member.display_name_source = 'OPENWA_PUSH_NAME')::text AS push_name_records,
         count(*) FILTER (WHERE member.shadow_projection_revision > 0)::text AS shadow_projected_records,
         count(*) FILTER (WHERE member.shadow_display_name IS NOT NULL)::text AS shadow_named_records,
         count(*) FILTER (WHERE member.shadow_resolved_phone_number IS NOT NULL)::text
           AS shadow_resolved_phone_records,
         count(*) FILTER (WHERE member.shadow_display_name_source = 'RESOLVED_ALIAS_PUSH_NAME')::text
           AS shadow_alias_push_records
       FROM group_members member
       LEFT JOIN contact_identifiers identifier
         ON identifier.session_id = member.session_id AND identifier.contact_id = member.contact_id
        AND identifier.identity_type = CASE
          WHEN member.participant_id LIKE '%@lid' THEN 'LID'
          WHEN member.participant_id LIKE '%@c.us' OR member.participant_id LIKE '%@s.whatsapp.net'
            THEN 'PHONE_JID'
          ELSE 'OTHER_JID'
        END
        AND identifier.identity_value = CASE
          WHEN member.participant_id LIKE '%@s.whatsapp.net'
            THEN regexp_replace(member.participant_id, '@s\\.whatsapp\\.net$', '@c.us')
          ELSE member.participant_id
        END
       WHERE member.session_id = $1`,
      [sessionId],
    );
    return Object.fromEntries(
      Object.entries(result.rows[0] ?? {}).map(([key, value]) => [key, Number(value)]),
    );
  }
}
