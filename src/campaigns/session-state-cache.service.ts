import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import IORedis from 'ioredis';
import { runtimeConfig } from '../config/runtime-config';
import { OpenWAClient } from '../openwa/openwa.client';
import type { PreflightSessionState } from './campaign-preflight';

@Injectable()
export class SessionStateCacheService implements OnApplicationShutdown {
  private readonly config = runtimeConfig();
  private readonly redis = new IORedis(this.config.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
  private readonly inFlight = new Map<string, Promise<PreflightSessionState>>();

  constructor(private readonly openwa: OpenWAClient) {}

  async get(sessionId: string): Promise<PreflightSessionState> {
    const key = `runtime:session-state:${sessionId}`;
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached) as PreflightSessionState;

    const existing = this.inFlight.get(sessionId);
    if (existing) return existing;
    const request = this.load(sessionId, key).finally(() => this.inFlight.delete(sessionId));
    this.inFlight.set(sessionId, request);
    return request;
  }

  async invalidate(sessionId: string): Promise<void> {
    await this.redis.del(`runtime:session-state:${sessionId}`);
  }

  private async load(sessionId: string, key: string): Promise<PreflightSessionState> {
    const session = await this.openwa.getSession(sessionId);
    const state: PreflightSessionState = {
      status: session.status,
      engineLoaded: session.engineLoaded,
      restricted: session.restriction != null,
    };
    await this.redis.set(key, JSON.stringify(state), 'EX', 10);
    return state;
  }

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
  }
}
