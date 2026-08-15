import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.dto';

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
