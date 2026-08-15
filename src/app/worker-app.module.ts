import { Module } from '@nestjs/common';
import { WorkerOrchestrationModule } from '../modules/orchestration/worker-orchestration.module';
import { RuntimeConfigModule } from '../core/config/runtime-config.module';

@Module({ imports: [RuntimeConfigModule, WorkerOrchestrationModule] })
export class WorkerAppModule {}
