import { ApiProperty } from '@nestjs/swagger';
import { PageMetaDto } from '../common/pagination.dto';

export class GroupSendCapabilityDto {
  @ApiProperty({ enum: ['ALLOWED', 'DENIED', 'UNKNOWN'] })
  status!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  checkedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  invalidatedAt!: Date | null;

  @ApiProperty({ minimum: 1 })
  revision!: number;
}

export class GroupMemberDto {
  @ApiProperty()
  participantId!: string;

  @ApiProperty({
    deprecated: true,
    description: 'Legacy OpenWA participant number; may be a LID user-part. Use resolvedPhoneNumber.',
  })
  phoneNumber!: string;

  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;

  @ApiProperty({
    enum: ['LID', 'PHONE_JID', 'OTHER_JID'],
    nullable: true,
    description: 'Normalized type of the exact upstream participant identity',
  })
  identityType!: 'LID' | 'PHONE_JID' | 'OTHER_JID' | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Verified phone resolution; null for unresolved or conflicted identities',
  })
  resolvedPhoneNumber!: string | null;

  @ApiProperty({
    enum: [
      'OPENWA_CONTACT_NAME',
      'GROUP_PARTICIPANT_NAME',
      'OPENWA_PUSH_NAME',
      'RESOLVED_ALIAS_PUSH_NAME',
    ],
    nullable: true,
    description: 'Provenance of displayName',
  })
  displayNameSource!:
    | 'OPENWA_CONTACT_NAME'
    | 'GROUP_PARTICIPANT_NAME'
    | 'OPENWA_PUSH_NAME'
    | 'RESOLVED_ALIAS_PUSH_NAME'
    | null;

  @ApiProperty({ minimum: 0, description: 'Monotonic materialized projection revision; 0 means legacy fallback' })
  projectionRevision!: number;

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

  @ApiProperty({ type: GroupSendCapabilityDto })
  sendCapability!: GroupSendCapabilityDto;
}

export class GroupDetailDto extends GroupDto {}

export class GroupListPageMetaDto extends PageMetaDto {
  @ApiProperty({ description: 'Total synchronized group records matching all current search and filter predicates' })
  declare total: number;
}

export class GroupListDto {
  @ApiProperty({ type: [GroupDto] })
  data!: GroupDto[];

  @ApiProperty({ type: GroupListPageMetaDto })
  meta!: GroupListPageMetaDto;
}

export class GroupMemberPageMetaDto extends PageMetaDto {
  @ApiProperty({ description: 'Total synchronized member records matching the current search filter' })
  declare total: number;

  @ApiProperty({
    minimum: 0,
    description: 'Monotonic group-level member dataset generation. It changes for every committed member insert, update, or delete; zero denotes the legacy projection path.',
  })
  datasetRevision!: number;
}

export class GroupMemberListDto {
  @ApiProperty({ type: [GroupMemberDto] })
  data!: GroupMemberDto[];

  @ApiProperty({
    type: GroupMemberPageMetaDto,
    description: 'Pagination metadata for the filtered synchronized member dataset',
  })
  meta!: GroupMemberPageMetaDto;
}
