import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

export enum CampaignExecutionMode {
  DRY_RUN = 'DRY_RUN',
  LIVE = 'LIVE',
}

export class CampaignPreflightRequestDto {
  @ApiProperty({ enum: CampaignExecutionMode, default: CampaignExecutionMode.DRY_RUN })
  @IsEnum(CampaignExecutionMode)
  executionMode!: CampaignExecutionMode;
}

export class CampaignPreflightCheckDto {
  @ApiProperty()
  code!: string;

  @ApiProperty({ enum: ['PASS', 'WARN', 'BLOCK'] })
  status!: string;

  @ApiProperty()
  message!: string;
}

export class CampaignTargetIssueDto {
  @ApiProperty()
  groupId!: string;

  @ApiProperty()
  groupName!: string;

  @ApiProperty({ enum: ['ALLOWED', 'DENIED', 'UNKNOWN'] })
  capability!: string;

  @ApiProperty()
  reason!: string;
}

export class CampaignPreflightDto {
  @ApiProperty({ enum: ['PASS', 'WARN', 'BLOCK'] })
  status!: string;

  @ApiProperty()
  policyVersion!: number;

  @ApiProperty({ enum: CampaignExecutionMode })
  executionMode!: CampaignExecutionMode;

  @ApiProperty({ format: 'date-time' })
  checkedAt!: Date;

  @ApiProperty()
  totalTargets!: number;

  @ApiProperty()
  allowedTargets!: number;

  @ApiProperty()
  deniedTargets!: number;

  @ApiProperty()
  unknownTargets!: number;

  @ApiProperty({ type: [CampaignPreflightCheckDto] })
  checks!: CampaignPreflightCheckDto[];

  @ApiProperty({ type: [CampaignTargetIssueDto] })
  targetIssues!: CampaignTargetIssueDto[];
}
