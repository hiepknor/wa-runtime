import { ApiProperty } from '@nestjs/swagger';
import { PageMetaDto } from '../common/pagination.dto';
import { GroupSendCapabilityDto } from '../groups/group.dto';

export class SavedGroupListDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Gateway session that owns this reusable list' })
  sessionId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: 'integer', minimum: 0 })
  groupCount!: number;

  @ApiProperty({ type: 'integer', minimum: 1 })
  revision!: number;

  @ApiProperty({
    type: 'integer', minimum: 1,
    description: 'Revision of the static group-ID membership only; metadata edits do not change it.',
  })
  membershipRevision!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  archivedAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class SavedGroupListPageMetaDto extends PageMetaDto {
  @ApiProperty({ description: 'Total active saved lists matching the current session and search query' })
  declare total: number;
}

export class SavedGroupListPageDto {
  @ApiProperty({ type: [SavedGroupListDto] })
  data!: SavedGroupListDto[];

  @ApiProperty({ type: SavedGroupListPageMetaDto })
  meta!: SavedGroupListPageMetaDto;
}

export class GroupListGroupDto {
  @ApiProperty({ example: '120363000000000000@g.us' })
  groupId!: string;

  @ApiProperty()
  groupName!: string;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ type: Number, nullable: true })
  participantsCount!: number | null;

  @ApiProperty({ type: GroupSendCapabilityDto })
  sendCapability!: GroupSendCapabilityDto;
}

export class GroupListMembershipDto {
  @ApiProperty({ type: SavedGroupListDto })
  list!: SavedGroupListDto;

  @ApiProperty({ type: [GroupListGroupDto], maxItems: 1000 })
  data!: GroupListGroupDto[];
}
