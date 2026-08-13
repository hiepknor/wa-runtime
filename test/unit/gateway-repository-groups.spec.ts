import { describe, expect, it, vi } from 'vitest';
import {
  GroupCapabilityFreshnessFilter,
  GroupCapabilityStatusFilter,
} from '../../src/contracts/groups/group-query.dto';
import type { DatabaseService } from '../../src/core/database/database.service';
import { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import { ContactRepository } from '../../src/modules/contacts/contact.repository';

describe('GatewayRepository.listGroups', () => {
  it('applies search, filters, deterministic pagination, and count in database queries', async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });
    const transaction = vi.fn(async operation => operation({ query: clientQuery }));
    const database = { transaction } as unknown as DatabaseService;
    const repository = new GatewayRepository(database, new ContactRepository(database));

    const result = await repository.listGroups({
      sessionId: 'session-id', limit: 20, offset: 40, query: '  100%_match  ',
      capabilityStatus: [GroupCapabilityStatusFilter.DENIED, GroupCapabilityStatusFilter.UNKNOWN],
      capabilityFreshness: [GroupCapabilityFreshnessFilter.STALE], isActive: false,
    });

    expect(result).toEqual({ data: [], total: 0 });
    expect(transaction).toHaveBeenCalledOnce();
    expect(clientQuery).toHaveBeenCalledTimes(3);
    expect(clientQuery.mock.calls[0]?.[0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    expect(clientQuery.mock.calls[1]?.[0]).toContain('ORDER BY name ASC, id ASC');
    expect(clientQuery.mock.calls[1]?.[0]).toContain('LIMIT $7 OFFSET $8');
    expect(clientQuery.mock.calls[1]?.[0]).not.toContain('group_members');
    expect(clientQuery.mock.calls[1]?.[1]).toEqual([
      'session-id', false, '100%_match', '%100\\%\\_match%', ['DENIED', 'UNKNOWN'], ['STALE'], 20, 40,
    ]);
    expect(clientQuery.mock.calls[2]?.[0]).toContain('count(*)');
    expect(clientQuery.mock.calls[2]?.[0]).not.toContain('group_members');
    expect(clientQuery.mock.calls[2]?.[1]).toEqual([
      'session-id', false, '100%_match', '%100\\%\\_match%', ['DENIED', 'UNKNOWN'], ['STALE'],
    ]);
  });
});
