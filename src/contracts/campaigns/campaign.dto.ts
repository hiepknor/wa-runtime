import { ApiProperty } from '@nestjs/swagger';
import { PageMetaDto } from '../common/pagination.dto';
import { CampaignScheduleType } from './create-campaign.dto';

export class CampaignDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  sessionId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  text!: string;

  @ApiProperty({ enum: CampaignScheduleType })
  scheduleType!: CampaignScheduleType;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  scheduledAt!: Date | null;

  @ApiProperty({ enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'] })
  status!: string;

  @ApiProperty()
  targetCount!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class CampaignListDto {
  @ApiProperty({ type: [CampaignDto] })
  data!: CampaignDto[];

  @ApiProperty({ type: PageMetaDto })
  meta!: PageMetaDto;
}
