import { ApiProperty } from '@nestjs/swagger';

export type SyncRunStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export class SyncRunDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  sessionId!: string;

  @ApiProperty({ example: 'FULL' })
  syncType!: string;

  @ApiProperty({ enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'] })
  status!: SyncRunStatus;

  @ApiProperty()
  groupsSynced!: number;

  @ApiProperty()
  membersSynced!: number;

  @ApiProperty({ type: String, nullable: true })
  error!: string | null;

  @ApiProperty({ format: 'date-time' })
  requestedAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt!: Date | null;
}
