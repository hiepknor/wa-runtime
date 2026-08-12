import { Injectable } from '@nestjs/common';
import type { MessageQueryDto } from '../../contracts/messages/message-query.dto';
import { SessionScopeService } from '../gateway/session-scope.service';
import { InboxRepository } from './inbox.repository';

@Injectable()
export class InboxService {
  constructor(
    private readonly repository: InboxRepository,
    private readonly sessions: SessionScopeService,
  ) {}

  async list(query: MessageQueryDto) {
    this.sessions.assertVisible(query.sessionId);
    const result = await this.repository.list(query);
    return { data: result.data, meta: { total: result.total, limit: query.limit, offset: query.offset } };
  }
}
