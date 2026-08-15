import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayNotEmpty, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min,
} from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.dto';

export enum GroupCapabilityStatusFilter {
  ALLOWED = 'ALLOWED',
  DENIED = 'DENIED',
  UNKNOWN = 'UNKNOWN',
}

export enum GroupCapabilityFreshnessFilter {
  CURRENT = 'CURRENT',
  STALE = 'STALE',
}

const commaSeparatedValues = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  return value.split(',').map(item => item.trim()).filter(Boolean);
};

const optionalBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

const optionalInteger = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
};

const postgresIntegerMaximum = 2_147_483_647;

export class GroupQueryDto extends PaginationQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Gateway session owning the read model' })
  @IsUUID()
  sessionId!: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Case-insensitive literal substring search across group name, group ID, and description. Whitespace is trimmed; an empty value disables search.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(200)
  query?: string;

  @ApiPropertyOptional({
    enum: GroupCapabilityStatusFilter,
    isArray: true,
    description: 'Comma-separated capability statuses. Values are ORed; this filter is ANDed with other filters.',
  })
  @IsOptional()
  @Transform(commaSeparatedValues)
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(GroupCapabilityStatusFilter, { each: true })
  capabilityStatus?: GroupCapabilityStatusFilter[];

  @ApiPropertyOptional({
    enum: GroupCapabilityFreshnessFilter,
    isArray: true,
    description: 'Comma-separated freshness values. CURRENT means no capability invalidation is pending; STALE means invalidated. Values are ORed.',
  })
  @IsOptional()
  @Transform(commaSeparatedValues)
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(GroupCapabilityFreshnessFilter, { each: true })
  capabilityFreshness?: GroupCapabilityFreshnessFilter[];

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Filter active or inactive synchronized groups. Omission preserves the active-only list behavior.',
  })
  @IsOptional()
  @Transform(optionalBoolean)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    type: 'integer',
    format: 'int32',
    minimum: 0,
    maximum: postgresIntegerMaximum,
    description: 'Inclusive minimum synchronized participant count. Groups with an unknown count do not match.',
  })
  @IsOptional()
  @Transform(optionalInteger)
  @IsInt()
  @Min(0)
  @Max(postgresIntegerMaximum)
  minParticipants?: number;

  @ApiPropertyOptional({
    type: 'integer',
    format: 'int32',
    minimum: 0,
    maximum: postgresIntegerMaximum,
    description: 'Inclusive maximum synchronized participant count. Groups with an unknown count do not match.',
  })
  @IsOptional()
  @Transform(optionalInteger)
  @IsInt()
  @Min(0)
  @Max(postgresIntegerMaximum)
  maxParticipants?: number;
}

export class GroupMemberQueryDto extends PaginationQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Gateway session owning the read model' })
  @IsUUID()
  sessionId!: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Case-insensitive literal substring search across display name, phone number, and participant ID',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(200)
  query?: string;
}

export class GroupIdentityQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Gateway session owning the group' })
  @IsUUID()
  sessionId!: string;
}
