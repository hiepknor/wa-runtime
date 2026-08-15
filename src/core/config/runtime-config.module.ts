import { Global, Module } from '@nestjs/common';
import { runtimeConfig } from './runtime-config';

export const RUNTIME_CONFIG = Symbol('RUNTIME_CONFIG');

@Global()
@Module({
  providers: [{ provide: RUNTIME_CONFIG, useFactory: runtimeConfig }],
  exports: [RUNTIME_CONFIG],
})
export class RuntimeConfigModule {}
