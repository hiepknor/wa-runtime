import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../src/core/database/database.service';
import { GatewayRepository } from '../../src/modules/gateway/gateway.repository';

describe('GatewayRepository.listMembers', () => {
  it('applies filtering, ordering, limit, and offset in database queries', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        participant_id: 'member@c.us', phone_number: '84900000000', display_name: 'Member',
        is_admin: false, is_super_admin: false,
      }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });
    const repository = new GatewayRepository({ query } as unknown as DatabaseService);

    const result = await repository.listMembers('session-id', 'group-id', 25, 50, '  100%_match  ');

    expect(result).toEqual({
      data: [{
        participantId: 'member@c.us', phoneNumber: '84900000000', displayName: 'Member',
        isAdmin: false, isSuperAdmin: false,
      }],
      total: 1,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain('LIMIT $3 OFFSET $4');
    expect(query.mock.calls[0]?.[0]).toContain('participant_id ASC');
    expect(query.mock.calls[0]?.[1]).toEqual(['session-id', 'group-id', 25, 50, '%100\\%\\_match%']);
    expect(query.mock.calls[1]?.[0]).toContain('count(*)');
    expect(query.mock.calls[1]?.[1]).toEqual(['session-id', 'group-id', '%100\\%\\_match%']);
  });
});
