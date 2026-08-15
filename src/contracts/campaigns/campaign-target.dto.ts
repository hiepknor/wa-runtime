import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import { GroupSendCapabilityDto } from '../groups/group.dto';

export class ReplaceCampaignTargetsDto {
  @ApiPropertyOptional({
    type: 'integer', minimum: 0,
    description: 'Target-set revision observed by the editor. A stale value returns HTTP 409.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedTargetsRevision?: number;

  @ApiProperty({
    type: [String],
    maxItems: 1000,
    uniqueItems: true,
    description: 'Complete replacement set. Duplicate IDs are rejected and response order is canonical.',
    example: ['120363000000000000@g.us'],
  })
  @IsArray()
  @IsString({ each: true })
  @Matches(/^[^\s]+@g\.us$/, { each: true })
  groupIds!: string[];
}

export class CampaignTargetDto {
  @ApiProperty()
  groupId!: string;

  @ApiProperty()
  groupName!: string;

  @ApiProperty()
  enabled!: boolean;

  @ApiProperty({ type: GroupSendCapabilityDto })
  sendCapability!: GroupSendCapabilityDto;
}

export class CampaignTargetListDto {
  @ApiProperty({ type: [CampaignTargetDto] })
  data!: CampaignTargetDto[];

  @ApiProperty({
    type: 'integer', minimum: 0,
    description: 'Canonical target-set revision represented by this complete response.',
  })
  targetsRevision!: number;
}
