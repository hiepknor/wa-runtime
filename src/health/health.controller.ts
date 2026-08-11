import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { runtimeConfig } from '../config/runtime-config';
import { DatabaseService } from '../database/database.service';

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
    };
  }
}
