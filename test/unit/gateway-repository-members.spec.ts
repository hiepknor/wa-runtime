import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../src/core/database/database.service';
import { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import { ContactRepository } from '../../src/modules/contacts/contact.repository';

describe('GatewayRepository.listMembers', () => {
  it('applies filtering, ordering, limit, and offset in database queries', async () => {
    const clientQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        participant_id: 'member@c.us', phone_number: '84900000000', display_name: 'Member',
        identity_type: 'PHONE_JID', resolved_phone_number: '84900000000',
        display_name_source: 'OPENWA_CONTACT_NAME', projection_revision: '12',
        is_admin: false, is_super_admin: false,
      }] })
      .mockResolvedValueOnce({ rows: [{ count: '1', dataset_revision: '12' }] });
    const transaction = vi.fn(async operation => operation({ query: clientQuery }));
    const database = { transaction } as unknown as DatabaseService;
    const repository = new GatewayRepository(database, new ContactRepository(database));

    const result = await repository.listMembers('session-id', 'group-id', 25, 50, '  100%_match  ');

    expect(result).toEqual({
      data: [{
        participantId: 'member@c.us', phoneNumber: '84900000000', displayName: 'Member',
        identityType: 'PHONE_JID', resolvedPhoneNumber: '84900000000',
        displayNameSource: 'OPENWA_CONTACT_NAME', projectionRevision: 12,
        isAdmin: false, isSuperAdmin: false,
      }],
      total: 1,
      datasetRevision: 12,
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(clientQuery).toHaveBeenCalledTimes(3);
    expect(clientQuery.mock.calls[0]?.[0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(clientQuery.mock.calls[1]?.[0]).toContain('LIMIT $3 OFFSET $4');
    expect(clientQuery.mock.calls[1]?.[0]).toContain('participant_id ASC');
    expect(clientQuery.mock.calls[1]?.[0]).toContain('shadow_projection_revision > 0');
    expect(clientQuery.mock.calls[1]?.[1]).toEqual([
      'session-id', 'group-id', 25, 50, '%100\\%\\_match%', false,
    ]);
    expect(clientQuery.mock.calls[2]?.[0]).toContain('count(*)');
    expect(clientQuery.mock.calls[2]?.[0]).toContain('member_dataset_revision');
    expect(clientQuery.mock.calls[2]?.[1]).toEqual([
      'session-id', 'group-id', '%100\\%\\_match%', false,
    ]);
  });
});
