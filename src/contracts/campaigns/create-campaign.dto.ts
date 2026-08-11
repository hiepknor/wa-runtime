import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export enum CampaignScheduleType {
  IMMEDIATE = 'IMMEDIATE',
  ONCE = 'ONCE',
}

export class CreateCampaignDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sessionId!: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ maxLength: 4096 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text!: string;

  @ApiPropertyOptional({ enum: CampaignScheduleType, default: CampaignScheduleType.IMMEDIATE })
  @IsOptional()
  @IsEnum(CampaignScheduleType)
  scheduleType: CampaignScheduleType = CampaignScheduleType.IMMEDIATE;

  @ApiPropertyOptional({ format: 'date-time', description: 'Required only for ONCE scheduling' })
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;
}
