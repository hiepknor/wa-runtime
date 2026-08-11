import { ApiProperty } from '@nestjs/swagger';
import { PageMetaDto } from '../common/pagination.dto';

export class InboundMessageDto {
  @ApiProperty({ format: 'uuid' })
  sessionId!: string;

  @ApiProperty()
  messageId!: string;

  @ApiProperty()
  groupId!: string;

  @ApiProperty()
  senderId!: string;

  @ApiProperty()
  body!: string;

  @ApiProperty()
  messageType!: string;

  @ApiProperty()
  fromMe!: boolean;

  @ApiProperty({ format: 'date-time' })
  receivedAt!: Date;
}

export class InboundMessageListDto {
  @ApiProperty({ type: [InboundMessageDto] })
  data!: InboundMessageDto[];

  @ApiProperty({ type: PageMetaDto })
  meta!: PageMetaDto;
}
