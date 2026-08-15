import { describe, expect, it, vi } from 'vitest';
import { CampaignRepository } from '../../src/modules/campaigns/campaign.repository';

describe('CampaignRepository target snapshots', () => {
  it('reads target data and targetsRevision through one repeatable-read client', async () => {
    const campaign = {
      id: '10000000-0000-4000-8000-000000000001',
      session_id: '20000000-0000-4000-8000-000000000001',
      name: 'Campaign',
      payload: { text: 'hello' },
      schedule_type: 'IMMEDIATE',
      scheduled_at: null,
      status: 'DRAFT',
      target_count: '1',
      revision: '1',
      targets_revision: '7',
      target_source_group_list_id: null,
      target_source_membership_revision: null,
      target_source_applied_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const target = {
      group_id: 'group@g.us',
      group_name: 'Group',
      enabled: true,
      send_capability: 'ALLOWED',
      send_capability_reason: 'SEND_ALLOWED',
      capability_checked_at: new Date(),
      capability_invalidated_at: null,
      capability_revision: 3,
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [campaign] })
      .mockResolvedValueOnce({ rows: [target] });
    const database = {
      query: vi.fn(),
      transaction: vi.fn(async (operation: (client: { query: typeof query }) => Promise<unknown>) =>
        operation({ query })),
    };
    const repository = new CampaignRepository(database as never, {} as never);

    const snapshot = await repository.getTargetsSnapshot(campaign.id);

    expect(database.query).not.toHaveBeenCalled();
    expect(query.mock.calls[0]?.[0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(snapshot).toMatchObject({
      campaign: { targetsRevision: 7 },
      targets: [{ groupId: 'group@g.us' }],
      source: null,
    });
  });
});
