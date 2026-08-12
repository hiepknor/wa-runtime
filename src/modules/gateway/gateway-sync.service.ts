import { ForbiddenException, Injectable } from '@nestjs/common';
import { runtimeConfig } from '../../core/config/runtime-config';
import type { SyncRunDto } from '../../contracts/sessions/sync-run.dto';
import { OpenWAClient } from '../../integrations/openwa/openwa.client';
import { GatewayRepository } from './gateway.repository';

@Injectable()
export class GatewaySyncService {
  private readonly config = runtimeConfig();

  constructor(
    private readonly repository: GatewayRepository,
    private readonly openwa: OpenWAClient,
  ) {}

  async request(sessionId: string): Promise<SyncRunDto> {
    if (!this.config.OPENWA_ALLOWED_SESSION_IDS.includes(sessionId)) {
      throw new ForbiddenException('Session is not in OPENWA_ALLOWED_SESSION_IDS');
    }
    return this.repository.createSyncRun(sessionId);
  }

  async perform(syncRunId: string, sessionId: string): Promise<{ groups: number; members: number }> {
    await this.repository.updateSyncRun(syncRunId, { status: 'RUNNING' });
    let groupsSynced = 0;
    let membersSynced = 0;
    try {
      await this.openwa.assertCompatibleRelease();
      const session = await this.openwa.getSession(sessionId);
      await this.repository.upsertSession(session);
      const groups = await this.openwa.listGroups(sessionId);
      await this.repository.replaceGroupSummaries(sessionId, groups);
      const concurrency = 4;
      for (let offset = 0; offset < groups.length; offset += concurrency) {
        const batch = groups.slice(offset, offset + concurrency);
        const results = await Promise.all(batch.map(async summary => {
          const group = await this.openwa.getGroup(sessionId, summary.id);
          return this.repository.upsertGroupDetails(sessionId, group);
        }));
        for (const result of results) {
          membersSynced += result.members;
          if (result.applied) groupsSynced += 1;
        }
      }
      await this.repository.updateSyncRun(syncRunId, {
        status: 'COMPLETED', groups: groupsSynced, members: membersSynced,
      });
      return { groups: groupsSynced, members: membersSynced };
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error);
      await this.repository.updateSyncRun(syncRunId, {
        status: 'FAILED', groups: groupsSynced, members: membersSynced, error: description,
      });
      throw error;
    }
  }

  async refreshGroupCapability(
    sessionId: string,
    groupId: string,
    expectedRevision: number,
  ): Promise<{ applied: boolean }> {
    if (!this.config.OPENWA_ALLOWED_SESSION_IDS.includes(sessionId)) {
      throw new ForbiddenException('Session is not in OPENWA_ALLOWED_SESSION_IDS');
    }
    try {
      const group = await this.openwa.getGroup(sessionId, groupId);
      const result = await this.repository.upsertGroupDetails(sessionId, group, expectedRevision);
      return { applied: result.applied };
    } catch (error) {
      await this.repository.markCapabilityRefreshFailed(sessionId, groupId, expectedRevision);
      throw error;
    }
  }
}
