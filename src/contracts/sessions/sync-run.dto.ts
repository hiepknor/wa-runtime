import { ApiProperty } from '@nestjs/swagger';
import { GatewaySyncMode } from './sync-request.dto';

export type SyncRunStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export type SyncRunPhase = 'DISCOVERING' | 'RECONCILING' | 'COMPLETED';

export class SyncRunDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  sessionId!: string;

  @ApiProperty({ enum: GatewaySyncMode })
  syncType!: GatewaySyncMode;

  @ApiProperty({ enum: ['DISCOVERING', 'RECONCILING', 'COMPLETED'] })
  phase!: SyncRunPhase;

  @ApiProperty({ enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'] })
  status!: SyncRunStatus;

  @ApiProperty()
  groupsSynced!: number;

  @ApiProperty({ description: 'Total groups returned by authoritative discovery' })
  groupsDiscovered!: number;

  @ApiProperty({ description: 'Groups selected for detail reconciliation in this run' })
  groupsScheduled!: number;

  @ApiProperty({ description: 'Groups whose reconciliation exhausted retries' })
  groupsFailed!: number;

  @ApiProperty({ description: 'Groups skipped because they disappeared during reconciliation' })
  groupsSkipped!: number;

  @ApiProperty({ description: 'Group reconciliations waiting for their first attempt' })
  groupsPending!: number;

  @ApiProperty({ description: 'Group reconciliations that currently own a processing lease' })
  groupsRunning!: number;

  @ApiProperty({ description: 'Group reconciliations waiting for a durable retry' })
  groupsRetrying!: number;

  @ApiProperty({ description: 'Members observed in successfully reconciled group snapshots; not rows changed' })
  membersSynced!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  nextAttemptAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cooldownUntil!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  error!: string | null;

  @ApiProperty({ format: 'date-time' })
  requestedAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt!: Date | null;
}
