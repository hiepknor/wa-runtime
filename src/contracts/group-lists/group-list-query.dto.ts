import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.dto';

const optionalInteger = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
};

export class GroupListQueryDto extends PaginationQueryDto {
  @ApiProperty({ description: 'Allowlisted Gateway session that owns the lists' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  sessionId!: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Trimmed case-insensitive literal substring search on list name and description',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(200)
  query?: string;
}

export class GroupListArchiveQueryDto {
  @ApiPropertyOptional({
    type: 'integer', minimum: 1,
    description: 'Aggregate revision observed before archive. A stale value returns HTTP 409.',
  })
  @IsOptional()
  @Transform(optionalInteger)
  @IsInt()
  @Min(1)
  expectedRevision?: number;
}
