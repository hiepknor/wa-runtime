import { ApiProperty } from '@nestjs/swagger';

export class SessionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ example: 'ready' })
  status!: string;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  pushName!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  connectedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastActiveAt!: Date | null;

  @ApiProperty()
  engineLoaded!: boolean;

  @ApiProperty({ type: String, nullable: true })
  lastError!: string | null;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  restriction!: Record<string, unknown> | null;

  @ApiProperty({ format: 'date-time' })
  gatewayCreatedAt!: Date;

  @ApiProperty({ format: 'date-time' })
  gatewayUpdatedAt!: Date;

  @ApiProperty({ format: 'date-time' })
  syncedAt!: Date;
}

export class SessionListDto {
  @ApiProperty({ type: [SessionDto] })
  data!: SessionDto[];
}
