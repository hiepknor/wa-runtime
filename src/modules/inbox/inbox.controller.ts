import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InboundMessageListDto } from '../../contracts/messages/message.dto';
import { MessageQueryDto } from '../../contracts/messages/message-query.dto';
import { InboxService } from './inbox.service';

@ApiTags('messages')
@ApiSecurity('runtime-key')
@Controller('messages')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  @ApiOperation({ summary: 'List normalized inbound group messages' })
  @ApiOkResponse({ type: InboundMessageListDto })
  async list(@Query() query: MessageQueryDto) {
    return this.inbox.list(query);
  }
}
