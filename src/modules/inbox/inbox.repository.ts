import { Injectable } from '@nestjs/common';
import type { InboundMessageDto } from '../../contracts/messages/message.dto';
import { DatabaseService } from '../../core/database/database.service';

interface InboundMessageRow {
  session_id: string;
  message_id: string;
  group_id: string;
  sender_id: string;
  body: string;
  message_type: string;
  from_me: boolean;
  received_at: Date;
}

const map = (row: InboundMessageRow): InboundMessageDto => ({
  sessionId: row.session_id, messageId: row.message_id, groupId: row.group_id,
  senderId: row.sender_id, body: row.body, messageType: row.message_type,
  fromMe: row.from_me, receivedAt: row.received_at,
});

@Injectable()
export class InboxRepository {
  constructor(private readonly database: DatabaseService) {}

  async list(input: { sessionId: string; groupId?: string; limit: number; offset: number }) {
    const filter = input.groupId ? 'session_id = $1 AND group_id = $2' : 'session_id = $1';
    const pagination = input.groupId ? [input.sessionId, input.groupId, input.limit, input.offset] : [input.sessionId, input.limit, input.offset];
    const limitIndex = input.groupId ? 3 : 2;
    const offsetIndex = input.groupId ? 4 : 3;
    const countValues = input.groupId ? [input.sessionId, input.groupId] : [input.sessionId];
    const [rows, count] = await Promise.all([
      this.database.query<InboundMessageRow>(
        `SELECT session_id, message_id, group_id, sender_id, body, message_type, from_me, received_at
         FROM inbound_messages WHERE ${filter}
         ORDER BY received_at DESC, message_id LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
        pagination,
      ),
      this.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM inbound_messages WHERE ${filter}`, countValues,
      ),
    ]);
    return { data: rows.rows.map(map), total: Number(count.rows[0]?.count ?? 0) };
  }
}
