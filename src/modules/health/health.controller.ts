import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../core/auth/public.decorator';
import { runtimeConfig } from '../../core/config/runtime-config';
import { DatabaseService } from '../../core/database/database.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Public()
  @Get('live')
  live() {
    return { status: 'ok', service: 'automation-runtime', version: '0.1.0' };
  }

  @Public()
  @Get('ready')
  async ready() {
    await this.database.query('SELECT 1');
    return {
      status: 'ready',
      liveSendsEnabled: runtimeConfig().ALLOW_LIVE_SENDS,
      openwaRelease: runtimeConfig().OPENWA_RELEASE_TAG,
      allowedSessionCount: runtimeConfig().OPENWA_ALLOWED_SESSION_IDS.length,
    };
  }
}
