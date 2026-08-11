import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MessageJobRepository } from './messages/message-job.repository';
import { QueueService } from './queue/queue.service';

const POLL_INTERVAL_MS = 1_000;
const BATCH_SIZE = 100;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  const repository = app.get(MessageJobRepository);
  const queues = app.get(QueueService);
  let stopping = false;

  const stop = () => {
    stopping = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  while (!stopping) {
    await repository.recoverStaleQueued();
    const jobs = await repository.claimDue(BATCH_SIZE);
    for (const job of jobs) {
      try {
        await queues.messageSend.add(
          'send-text',
          { messageJobId: job.id },
          { jobId: job.id, attempts: 1, removeOnComplete: 1000, removeOnFail: 5000 },
        );
      } catch (error) {
        await repository.resetQueued(job.id, error instanceof Error ? error.message : String(error));
      }
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  await app.close();
}

bootstrap().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
