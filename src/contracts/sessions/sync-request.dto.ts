import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

export enum GatewaySyncMode {
  FULL = 'FULL',
  INCREMENTAL = 'INCREMENTAL',
}

export class SyncRequestDto {
  @ApiPropertyOptional({
    enum: GatewaySyncMode,
    default: GatewaySyncMode.FULL,
    description: 'FULL reconciles every discovered group; INCREMENTAL reconciles only new, changed, invalidated or stale groups. Omission preserves FULL behavior.',
  })
  @IsOptional()
  @IsEnum(GatewaySyncMode)
  mode: GatewaySyncMode = GatewaySyncMode.FULL;
}
