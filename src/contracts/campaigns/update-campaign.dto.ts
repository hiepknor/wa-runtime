import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsISO8601, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { CampaignScheduleType } from './create-campaign.dto';

export class UpdateCampaignDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ maxLength: 4096 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text?: string;

  @ApiPropertyOptional({ enum: CampaignScheduleType })
  @IsOptional()
  @IsEnum(CampaignScheduleType)
  scheduleType?: CampaignScheduleType;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string | null;
}
