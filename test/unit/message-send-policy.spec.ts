import { describe, expect, it, vi } from 'vitest';
import type { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import type { SessionScopeService } from '../../src/modules/gateway/session-scope.service';
import { MessageSendPolicyService } from '../../src/modules/messages/message-send-policy.service';

describe('MessageSendPolicyService', () => {
  it('allows dry-run after checking the deployment session scope', async () => {
    const sessions = { assertAllowed: vi.fn() };
    const gateway = { findGroup: vi.fn() };
    const policy = new MessageSendPolicyService(
      gateway as unknown as GatewayRepository,
      sessions as unknown as SessionScopeService,
    );

    await policy.assertCreatable('session-1', 'recipient', true);

    expect(sessions.assertAllowed).toHaveBeenCalledWith('session-1');
    expect(gateway.findGroup).not.toHaveBeenCalled();
  });

  it('blocks low-level live sends when group capability is not allowed', async () => {
    const sessions = { assertAllowed: vi.fn() };
    const gateway = {
      findGroup: vi.fn().mockResolvedValue({
        sendCapability: { status: 'UNKNOWN', reason: 'GROUP_CHANGED' },
      }),
    };
    const policy = new MessageSendPolicyService(
      gateway as unknown as GatewayRepository,
      sessions as unknown as SessionScopeService,
    );

    await expect(policy.assertCreatable('session-1', 'group@g.us', false))
      .rejects.toThrow('Group is not sendable: GROUP_CHANGED');
  });

  it('rechecks session and group state immediately before live delivery', async () => {
    const sessions = { isAllowed: vi.fn().mockReturnValue(true) };
    const gateway = {
      isSessionSendable: vi.fn().mockResolvedValue(true),
      findGroup: vi.fn().mockResolvedValue({
        sendCapability: { status: 'ALLOWED', reason: 'SEND_ALLOWED' },
      }),
    };
    const policy = new MessageSendPolicyService(
      gateway as unknown as GatewayRepository,
      sessions as unknown as SessionScopeService,
    );

    await expect(policy.liveBlockReason('session-1', 'group@g.us')).resolves.toBeNull();
  });
});
