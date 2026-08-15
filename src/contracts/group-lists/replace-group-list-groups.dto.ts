import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

export class ReplaceGroupListGroupsDto {
  @ApiPropertyOptional({
    type: 'integer', minimum: 1,
    deprecated: true,
    description: 'Aggregate revision observed by a legacy editor. Prefer expectedMembershipRevision.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedRevision?: number;

  @ApiPropertyOptional({
    type: 'integer', minimum: 1,
    description: 'Membership revision represented by the editor. A stale value returns HTTP 409.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedMembershipRevision?: number;

  @ApiProperty({
    type: [String],
    maxItems: 1000,
    uniqueItems: true,
    description: 'Complete static replacement set. Duplicate IDs are rejected.',
    example: ['120363000000000000@g.us'],
  })
  @IsArray()
  @IsString({ each: true })
  @Matches(/^[^\s]+@g\.us$/, { each: true })
  groupIds!: string[];
}
