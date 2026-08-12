import { Module } from '@nestjs/common';
import { WorkerOrchestrationModule } from '../modules/orchestration/worker-orchestration.module';

@Module({ imports: [WorkerOrchestrationModule] })
export class WorkerAppModule {}
