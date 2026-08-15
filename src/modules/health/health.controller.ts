import { Controller, Get, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../core/auth/public.decorator';
import { HealthLiveDto, HealthNotReadyDto, HealthReadyDto } from '../../contracts/health/health.dto';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { DatabaseService } from '../../core/database/database.service';
import { QueueService, type RuntimeProcessHealth } from '../../core/queue/queue.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly queues: QueueService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  @Public()
  @Get('live')
  @ApiOkResponse({ type: HealthLiveDto })
  live(): HealthLiveDto {
    return { status: 'ok', service: 'wa-runtime', version: '0.1.0' };
  }

  @Public()
  @Get('ready')
  @ApiOkResponse({ type: HealthReadyDto })
  @ApiServiceUnavailableResponse({ type: HealthNotReadyDto })
  async ready(): Promise<HealthReadyDto> {
    let processes: RuntimeProcessHealth;
    try {
      await this.database.query('SELECT 1');
      await this.queues.readiness();
      processes = await this.queues.runtimeProcessHealth();
    } catch (error) {
      this.logger.error({ event: 'runtime.readiness.failed', error });
      throw new ServiceUnavailableException({
        status: 'not_ready',
        reason: 'Runtime dependency unavailable',
      });
    }
    return {
      status: 'ready',
      dependencies: { postgres: true, redis: true },
      processes,
      liveSendsEnabled: this.config.ALLOW_LIVE_SENDS,
      openwaRelease: this.config.OPENWA_RELEASE_TAG,
      allowedSessionCount: this.config.OPENWA_ALLOWED_SESSION_IDS.length,
    };
  }
}
