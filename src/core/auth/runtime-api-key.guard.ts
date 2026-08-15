import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { runtimeConfig, type RuntimeConfig } from '../config/runtime-config';
import { RUNTIME_CONFIG } from '../config/runtime-config.module';
import { IS_PUBLIC } from './public.decorator';

@Injectable()
export class RuntimeApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const supplied = request.header('x-runtime-key');
    if (!supplied || supplied !== this.config.RUNTIME_API_KEY) {
      throw new UnauthorizedException('Missing or invalid X-Runtime-Key');
    }
    return true;
  }
}
