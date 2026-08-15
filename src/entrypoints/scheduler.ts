import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SchedulerAppModule } from '../app/scheduler-app.module';
import { SchedulerRunnerService } from '../modules/orchestration/scheduler-runner.service';
import { JsonLogger } from '../core/observability/json-logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SchedulerAppModule, { logger: new JsonLogger('scheduler') });
  try {
    await app.get(SchedulerRunnerService).run();
  } finally {
    await app.close();
  }
}

bootstrap().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
