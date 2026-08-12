import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerAppModule } from '../app/worker-app.module';
import { WorkerRunnerService } from '../modules/orchestration/worker-runner.service';
import { JsonLogger } from '../core/observability/json-logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerAppModule, { logger: new JsonLogger('worker') });
  await app.get(WorkerRunnerService).run();
  await app.close();
}

bootstrap().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
