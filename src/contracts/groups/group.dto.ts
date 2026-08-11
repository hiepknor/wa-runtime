import { ApiProperty } from '@nestjs/swagger';
import { PageMetaDto } from '../common/pagination.dto';

export class GroupMemberDto {
  @ApiProperty()
  participantId!: string;

  @ApiProperty()
  phoneNumber!: string;

  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;

  @ApiProperty()
  isAdmin!: boolean;

  @ApiProperty()
  isSuperAdmin!: boolean;
}

export class GroupDto {
  @ApiProperty({ format: 'uuid' })
  sessionId!: string;

  @ApiProperty({ example: '120363000000000000@g.us' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ownerId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  linkedParentId!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  participantsCount!: number | null;

  @ApiProperty({ type: Boolean, nullable: true })
  isAdmin!: boolean | null;

  @ApiProperty({ type: Boolean, nullable: true })
  isReadOnly!: boolean | null;

  @ApiProperty({ type: Boolean, nullable: true })
  isAnnounce!: boolean | null;

  @ApiProperty({ type: Boolean, nullable: true })
  settingsLocked!: boolean | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  detailsSyncedAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  syncedAt!: Date;
}

export class GroupDetailDto extends GroupDto {
  @ApiProperty({ type: [GroupMemberDto] })
  members!: GroupMemberDto[];
}

export class GroupListDto {
  @ApiProperty({ type: [GroupDto] })
  data!: GroupDto[];

  @ApiProperty({ type: PageMetaDto })
  meta!: PageMetaDto;
}

export class GroupMemberListDto {
  @ApiProperty({ type: [GroupMemberDto] })
  data!: GroupMemberDto[];

  @ApiProperty({ type: PageMetaDto })
  meta!: PageMetaDto;
}
