import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { PageMetaDto } from '../common/pagination.dto';
import { CampaignExecutionMode, CampaignPreflightDto } from './campaign-preflight.dto';

export class CreateCampaignRunDto {
  @ApiProperty({ enum: CampaignExecutionMode, default: CampaignExecutionMode.DRY_RUN })
  @IsEnum(CampaignExecutionMode)
  executionMode!: CampaignExecutionMode;
}

export class CampaignRunDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  campaignId!: string;

  @ApiProperty({ format: 'uuid' })
  sessionId!: string;

  @ApiProperty({ enum: CampaignExecutionMode })
  executionMode!: CampaignExecutionMode;

  @ApiProperty({ enum: ['PREPARING', 'BLOCKED', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'PARTIAL_FAILED', 'CANCELLED', 'FAILED'] })
  status!: string;

  @ApiProperty()
  text!: string;

  @ApiProperty({ type: CampaignPreflightDto, nullable: true })
  preflight!: CampaignPreflightDto | null;

  @ApiProperty()
  totalTargets!: number;

  @ApiProperty({ format: 'date-time' })
  scheduledAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class CampaignRunListDto {
  @ApiProperty({ type: [CampaignRunDto] })
  data!: CampaignRunDto[];

  @ApiProperty({ type: PageMetaDto })
  meta!: PageMetaDto;
}
