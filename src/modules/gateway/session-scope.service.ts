import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { runtimeConfig } from '../../core/config/runtime-config';

@Injectable()
export class SessionScopeService {
  private readonly allowedIds = new Set(runtimeConfig().OPENWA_ALLOWED_SESSION_IDS);

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
