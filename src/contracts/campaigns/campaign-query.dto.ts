import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.dto';
import { CampaignStatus } from './campaign.dto';
import { CampaignScheduleType } from './create-campaign.dto';

const commaSeparatedValues = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  return value.split(',').map(item => item.trim()).filter(Boolean);
};

export class CampaignQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  sessionId?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Trimmed case-insensitive literal substring search on campaign name, or exact campaign UUID.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(200)
  query?: string;

  @ApiPropertyOptional({
    enum: CampaignStatus,
    isArray: true,
    description: 'Comma-separated campaign statuses. Values are ORed and combined with other filters using AND.',
  })
  @IsOptional()
  @Transform(commaSeparatedValues)
  @IsArray()
  @IsEnum(CampaignStatus, { each: true })
  status?: CampaignStatus[];

  @ApiPropertyOptional({
    enum: CampaignScheduleType,
    isArray: true,
    description: 'Comma-separated schedule types. Values are ORed and combined with other filters using AND.',
  })
  @IsOptional()
  @Transform(commaSeparatedValues)
  @IsArray()
  @IsEnum(CampaignScheduleType, { each: true })
  scheduleType?: CampaignScheduleType[];
}
