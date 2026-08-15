import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateGroupListDto {
  @ApiProperty({ description: 'Allowlisted Gateway session that owns the list' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  sessionId!: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({
    type: [String],
    maxItems: 1000,
    uniqueItems: true,
    default: [],
    description: 'Initial static membership. Inactive and non-ALLOWED groups remain valid list entries.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(/^[^\s]+@g\.us$/, { each: true })
  groupIds?: string[];
}
