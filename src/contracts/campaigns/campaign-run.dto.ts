import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { PageMetaDto } from '../common/pagination.dto';
import { CampaignExecutionMode, CampaignPreflightDto } from './campaign-preflight.dto';
import { CampaignTargetSourceDto } from './campaign-target.dto';

export class CreateCampaignRunDto {
  @ApiProperty({ enum: CampaignExecutionMode, default: CampaignExecutionMode.DRY_RUN })
  @IsEnum(CampaignExecutionMode)
  executionMode!: CampaignExecutionMode;

  @ApiProperty({
    type: 'integer', minimum: 1, required: false,
    description: 'Campaign content revision to launch. A stale value returns HTTP 409.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedCampaignRevision?: number;

  @ApiProperty({
    type: 'integer', minimum: 0, required: false,
    description: 'Campaign target revision to launch. A stale value returns HTTP 409.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedTargetsRevision?: number;
}

export class CampaignRunProgressDto {
  @ApiProperty() total!: number;
  @ApiProperty() pending!: number;
  @ApiProperty() materialized!: number;
  @ApiProperty() processing!: number;
  @ApiProperty() dryRunCompleted!: number;
  @ApiProperty() accepted!: number;
  @ApiProperty() sent!: number;
  @ApiProperty() delivered!: number;
  @ApiProperty() read!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() unknown!: number;
  @ApiProperty() blocked!: number;
  @ApiProperty() cancelled!: number;
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

  @ApiProperty({ type: String, nullable: true })
  statusReason!: string | null;

  @ApiProperty()
  text!: string;

  @ApiProperty({ type: CampaignTargetSourceDto, nullable: true })
  targetSource!: CampaignTargetSourceDto | null;

  @ApiProperty({ type: CampaignPreflightDto, nullable: true })
  preflight!: CampaignPreflightDto | null;

  @ApiProperty()
  totalTargets!: number;

  @ApiProperty({ type: CampaignRunProgressDto })
  progress!: CampaignRunProgressDto;

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
