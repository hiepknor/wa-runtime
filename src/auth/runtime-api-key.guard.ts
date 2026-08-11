import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { runtimeConfig } from '../config/runtime-config';
import { IS_PUBLIC } from './public.decorator';

@Injectable()
export class RuntimeApiKeyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const supplied = request.header('x-runtime-key');
    if (!supplied || supplied !== runtimeConfig().RUNTIME_API_KEY) {
      throw new UnauthorizedException('Missing or invalid X-Runtime-Key');
    }
    return true;
  }
}
