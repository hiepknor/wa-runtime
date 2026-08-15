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
      minParticipants: 0, maxParticipants: 500,
    });

    expect(result).toEqual({ data: [], total: 0 });
    expect(transaction).toHaveBeenCalledOnce();
    expect(clientQuery).toHaveBeenCalledTimes(3);
    expect(clientQuery.mock.calls[0]?.[0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(clientQuery.mock.calls[1]?.[0]).toContain('ORDER BY name ASC, id ASC');
    expect(clientQuery.mock.calls[1]?.[0]).toContain('participants_count >= $7::integer');
    expect(clientQuery.mock.calls[1]?.[0]).toContain('participants_count <= $8::integer');
    expect(clientQuery.mock.calls[1]?.[0]).toContain('LIMIT $9 OFFSET $10');
    expect(clientQuery.mock.calls[1]?.[0]).not.toContain('group_members');
    expect(clientQuery.mock.calls[1]?.[1]).toEqual([
      'session-id', false, '100%_match', '%100\\%\\_match%', ['DENIED', 'UNKNOWN'], ['STALE'], 0, 500, 20, 40,
    ]);
    expect(clientQuery.mock.calls[2]?.[0]).toContain('count(*)');
    expect(clientQuery.mock.calls[2]?.[0]).not.toContain('group_members');
    expect(clientQuery.mock.calls[2]?.[1]).toEqual([
      'session-id', false, '100%_match', '%100\\%\\_match%', ['DENIED', 'UNKNOWN'], ['STALE'], 0, 500,
    ]);
  });

  it('binds omitted participant bounds as null instead of using truthiness', async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });
    const database = {
      transaction: vi.fn(async operation => operation({ query: clientQuery })),
    } as unknown as DatabaseService;
    const repository = new GatewayRepository(database, new ContactRepository(database));

    await repository.listGroups({ sessionId: 'session-id', limit: 50, offset: 0 });

    expect(clientQuery.mock.calls[1]?.[1]).toEqual([
      'session-id', true, null, null, null, null, null, null, 50, 0,
    ]);
  });
});
