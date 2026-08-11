import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InboundMessageListDto } from '../../contracts/messages/message.dto';
import { MessageQueryDto } from '../../contracts/messages/message-query.dto';
import { InboxRepository } from './inbox.repository';

@ApiTags('messages')
@ApiSecurity('runtime-key')
@Controller('messages')
export class InboxController {
  constructor(private readonly repository: InboxRepository) {}

  @Get()
  @ApiOperation({ summary: 'List normalized inbound group messages' })
  @ApiOkResponse({ type: InboundMessageListDto })
  async list(@Query() query: MessageQueryDto) {
    const result = await this.repository.list(query);
    return { data: result.data, meta: { total: result.total, limit: query.limit, offset: query.offset } };
  }
}
