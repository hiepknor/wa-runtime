import { ApiProperty } from '@nestjs/swagger';
import { PageMetaDto } from '../common/pagination.dto';

export class CampaignDeliveryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  runId!: string;

  @ApiProperty()
  groupId!: string;

  @ApiProperty()
  groupName!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  messageJobId!: string | null;

  @ApiProperty()
  status!: string;

  @ApiProperty({ type: String, nullable: true })
  failureReason!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class CampaignDeliveryListDto {
  @ApiProperty({ type: [CampaignDeliveryDto] })
  data!: CampaignDeliveryDto[];

  @ApiProperty({ type: PageMetaDto })
  meta!: PageMetaDto;
}
