import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { OpenWAClient } from '../../integrations/openwa/openwa.client';
import { GatewayRepository } from './gateway.repository';

@Injectable()
export class SessionService {
  constructor(
    private readonly repository: GatewayRepository,
    private readonly openwa: OpenWAClient,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async list() {
    const upstream = await this.openwa.listSessions();
    const allowed = upstream.filter(session => this.config.OPENWA_ALLOWED_SESSION_IDS.includes(session.id));
    await Promise.all(allowed.map(session => this.repository.upsertSession(session)));
    return { data: await this.repository.listSessions(this.config.OPENWA_ALLOWED_SESSION_IDS) };
  }

  async get(id: string) {
    if (!this.config.OPENWA_ALLOWED_SESSION_IDS.includes(id)) throw new NotFoundException('Session not found');
    try {
      return await this.repository.upsertSession(await this.openwa.getSession(id));
    } catch {
      // The durable read model remains available during a transient gateway outage.
    }
    const session = await this.repository.findSession(id);
    if (!session) throw new NotFoundException('Session not found');
    return session;
  }
}
