import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

export enum CampaignExecutionMode {
  DRY_RUN = 'DRY_RUN',
  LIVE = 'LIVE',
}

export enum CampaignPreflightStatus {
  PASS = 'PASS',
  WARN = 'WARN',
  BLOCK = 'BLOCK',
}

export enum CampaignPreflightCheckCode {
  CONTENT_VALID = 'CONTENT_VALID',
  TARGETS_VALID = 'TARGETS_VALID',
  SESSION_SENDABLE = 'SESSION_SENDABLE',
  GROUP_CAPABILITY = 'GROUP_CAPABILITY',
  LIVE_SEND_ALLOWED = 'LIVE_SEND_ALLOWED',
}

export enum CampaignTargetIssueReason {
  TARGET_CAPABILITY_DENIED = 'TARGET_CAPABILITY_DENIED',
  TARGET_CAPABILITY_UNKNOWN = 'TARGET_CAPABILITY_UNKNOWN',
  TARGET_CAPABILITY_STALE = 'TARGET_CAPABILITY_STALE',
}

export class CampaignPreflightRequestDto {
  @ApiProperty({ enum: CampaignExecutionMode, default: CampaignExecutionMode.DRY_RUN })
  @IsEnum(CampaignExecutionMode)
  executionMode!: CampaignExecutionMode;
}

export class CampaignPreflightCheckDto {
  @ApiProperty({ enum: CampaignPreflightCheckCode })
  code!: CampaignPreflightCheckCode;

  @ApiProperty({ enum: CampaignPreflightStatus })
  status!: CampaignPreflightStatus;

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

  @ApiProperty({ enum: CampaignTargetIssueReason })
  reason!: CampaignTargetIssueReason;
}

export class CampaignPreflightDto {
  @ApiProperty({ enum: CampaignPreflightStatus })
  status!: CampaignPreflightStatus;

  @ApiProperty()
  policyVersion!: number;

  @ApiProperty({ minimum: 1 })
  campaignRevision!: number;

  @ApiProperty({ minimum: 0 })
  targetsRevision!: number;

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
