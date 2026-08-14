import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString, Matches } from 'class-validator';
import { GroupSendCapabilityDto } from '../groups/group.dto';

export class ReplaceCampaignTargetsDto {
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
}
