import { ApiProperty } from '@nestjs/swagger';

export class HealthLiveDto {
  @ApiProperty({ enum: ['ok'] })
  status!: 'ok';

  @ApiProperty({ enum: ['wa-runtime'] })
  service!: 'wa-runtime';

  @ApiProperty({ example: '0.1.0' })
  version!: string;
}

export class HealthDependenciesDto {
  @ApiProperty({ enum: [true] })
  postgres!: true;

  @ApiProperty({ enum: [true] })
  redis!: true;
}

export class RuntimeProcessHealthDto {
  @ApiProperty({ enum: ['healthy', 'degraded'] })
  worker!: 'healthy' | 'degraded';

  @ApiProperty({ enum: ['healthy', 'degraded'] })
  scheduler!: 'healthy' | 'degraded';
}

export class HealthReadyDto {
  @ApiProperty({ enum: ['ready'] })
  status!: 'ready';

  @ApiProperty({ type: HealthDependenciesDto })
  dependencies!: HealthDependenciesDto;

  @ApiProperty({ type: RuntimeProcessHealthDto })
  processes!: RuntimeProcessHealthDto;

  @ApiProperty()
  liveSendsEnabled!: boolean;

  @ApiProperty({ example: '0.18.0' })
  openwaRelease!: string;

  @ApiProperty({ minimum: 0 })
  allowedSessionCount!: number;
}

export class HealthNotReadyDto {
  @ApiProperty({ enum: ['not_ready'] })
  status!: 'not_ready';

  @ApiProperty({ enum: ['Runtime dependency unavailable'] })
  reason!: 'Runtime dependency unavailable';
}
