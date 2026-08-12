import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../core/auth/public.decorator';
import { runtimeConfig } from '../../core/config/runtime-config';
import { DatabaseService } from '../../core/database/database.service';
import { QueueService } from '../../core/queue/queue.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly queues: QueueService,
  ) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok', service: 'automation-runtime', version: '0.1.0' };
  }

  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.database.query('SELECT 1');
      await this.queues.readiness();
    } catch (error) {
      this.logger.error({ event: 'runtime.readiness.failed', error });
      const heartbeatReason = error instanceof Error
        && error.message.startsWith('Runtime process heartbeat missing:')
        ? error.message
        : 'Runtime dependency unavailable';
      throw new ServiceUnavailableException({
        status: 'not_ready',
        reason: heartbeatReason,
      });
    }
    return {
      status: 'ready',
      dependencies: { postgres: true, redis: true, worker: true, scheduler: true },
      liveSendsEnabled: runtimeConfig().ALLOW_LIVE_SENDS,
      openwaRelease: runtimeConfig().OPENWA_RELEASE_TAG,
      allowedSessionCount: runtimeConfig().OPENWA_ALLOWED_SESSION_IDS.length,
    };
  }
}
