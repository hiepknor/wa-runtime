import { Module } from '@nestjs/common';
import { SchedulerOrchestrationModule } from '../modules/orchestration/scheduler-orchestration.module';

@Module({ imports: [SchedulerOrchestrationModule] })
export class SchedulerAppModule {}
