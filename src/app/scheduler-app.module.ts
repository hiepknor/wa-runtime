import { Module } from '@nestjs/common';
import { SchedulerOrchestrationModule } from '../modules/orchestration/scheduler-orchestration.module';
import { RuntimeConfigModule } from '../core/config/runtime-config.module';

@Module({ imports: [RuntimeConfigModule, SchedulerOrchestrationModule] })
export class SchedulerAppModule {}
