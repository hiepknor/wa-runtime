import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';

@Injectable()
export class SessionScopeService {
  private readonly allowedIds: Set<string>;

  constructor(@Inject(RUNTIME_CONFIG) config: RuntimeConfig = runtimeConfig()) {
    this.allowedIds = new Set(config.OPENWA_ALLOWED_SESSION_IDS);
  }

  isAllowed(sessionId: string): boolean {
    return this.allowedIds.has(sessionId);
  }

  assertAllowed(sessionId: string): void {
    if (!this.isAllowed(sessionId)) {
      throw new ForbiddenException('Session is not in OPENWA_ALLOWED_SESSION_IDS');
    }
  }

  assertVisible(sessionId: string): void {
    if (!this.isAllowed(sessionId)) throw new NotFoundException('Resource not found');
  }
}
