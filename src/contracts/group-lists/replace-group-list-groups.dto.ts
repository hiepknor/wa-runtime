import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString, Matches } from 'class-validator';

export class ReplaceGroupListGroupsDto {
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
