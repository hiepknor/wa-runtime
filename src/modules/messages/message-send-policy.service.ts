import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { GatewayRepository } from '../gateway/gateway.repository';
import { SessionScopeService } from '../gateway/session-scope.service';

@Injectable()
export class MessageSendPolicyService {
  constructor(
    private readonly gateway: GatewayRepository,
    private readonly sessions: SessionScopeService,
  ) {}

  async assertCreatable(sessionId: string, recipientId: string, dryRun: boolean): Promise<void> {
    this.sessions.assertAllowed(sessionId);
    if (dryRun) return;
    if (!recipientId.endsWith('@g.us')) {
      throw new BadRequestException('Live low-level message jobs require a synchronized group recipient');
    }
    const group = await this.gateway.findGroup(sessionId, recipientId);
    if (!group) throw new BadRequestException('Recipient group is not active in the synchronized read model');
    if (group.sendCapability.status !== 'ALLOWED') {
      throw new ConflictException(`Group is not sendable: ${group.sendCapability.reason}`);
    }
  }

  async liveBlockReason(sessionId: string, recipientId: string): Promise<string | null> {
    if (!this.sessions.isAllowed(sessionId)) return 'Session is outside the Runtime allowlist';
    if (!await this.gateway.isSessionSendable(sessionId)) return 'Gateway session is not sendable';
    if (!recipientId.endsWith('@g.us')) return 'Recipient is not a synchronized group';
    const group = await this.gateway.findGroup(sessionId, recipientId);
    if (!group) return 'Recipient group is not active in the synchronized read model';
    if (group.sendCapability.status !== 'ALLOWED') {
      return `Group is not sendable: ${group.sendCapability.reason}`;
    }
    return null;
  }
}
