import { ApiProperty } from '@nestjs/swagger';
import { GatewaySyncMode } from './sync-request.dto';

export class SyncModeConflictDto {
  @ApiProperty({ example: 409 })
  statusCode!: number;

  @ApiProperty({ example: 'SYNC_MODE_CONFLICT' })
  code!: string;

  @ApiProperty({ example: 'A different synchronization mode is already active' })
  message!: string;

  @ApiProperty({ format: 'uuid' })
  activeRunId!: string;

  @ApiProperty({ enum: GatewaySyncMode })
  activeMode!: GatewaySyncMode;
}
