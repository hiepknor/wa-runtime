import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../src/core/database/database.service';
import type { OpenWAGroup } from '../../src/integrations/openwa/openwa.client';
import { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import { ContactRepository } from '../../src/modules/contacts/contact.repository';

describe('GatewayRepository bulk member replacement', () => {
  it('upserts a full summary page with one database insert', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 });
    const database = {
      transaction: <T>(operation: (client: { query: typeof query }) => Promise<T>) => operation({ query }),
    } as unknown as DatabaseService;
    const groups = Array.from({ length: 1000 }, (_, index) => ({
      id: `group-${index}`,
      name: `Group ${index}`,
      participantsCount: index,
      isAdmin: index % 2 === 0,
    }));

    await new GatewayRepository(database, new ContactRepository(database)).replaceGroupSummaries('session-1', groups, {
      syncRunId: '00000000-0000-4000-8000-000000000001',
      leaseToken: '00000000-0000-4000-8000-000000000002',
      syncEpoch: '1',
    });

    const summaryInserts = query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO gateway_groups'));
    expect(summaryInserts).toHaveLength(1);
    expect(summaryInserts[0]?.[0]).toContain('jsonb_to_recordset');
    expect(JSON.parse(String(summaryInserts[0]?.[1][1]))).toHaveLength(1000);
  });

  it('replaces a large member collection with one database insert', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ details_fingerprint: null }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: Array.from({ length: 1000 }, (_, index) => ({ participant_id: `participant-${index}` })),
        rowCount: 1000,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const database = {
      transaction: <T>(operation: (client: { query: typeof query }) => Promise<T>) => operation({ query }),
    } as unknown as DatabaseService;
    const group: OpenWAGroup = {
      id: 'group-1',
      name: 'Large group',
      isAdmin: true,
      participants: Array.from({ length: 1000 }, (_, index) => ({
        id: `participant-${index}`,
        number: `phone-${index}`,
        name: index % 2 === 0 ? `Member ${index}` : undefined,
        isAdmin: index === 0,
        isSuperAdmin: index === 0,
      })),
    };

    await expect(new GatewayRepository(database, new ContactRepository(database)).upsertGroupDetails('session-1', group))
      .resolves.toEqual({ members: 1000, applied: true });

    const memberInserts = query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO group_members'));
    expect(memberInserts).toHaveLength(1);
    expect(memberInserts[0]?.[0]).toContain('unnest');
    expect(memberInserts[0]?.[0]).toContain('ON CONFLICT');
    expect(memberInserts[0]?.[0]).toContain('IS DISTINCT FROM');
    expect(memberInserts[0]?.[1][2]).toHaveLength(1000);
    const contactBatches = query.mock.calls.filter(([sql]) => String(sql).includes('jsonb_to_recordset'));
    expect(contactBatches).toHaveLength(3);
    expect(contactBatches.every(call => JSON.parse(String(call[1][2])).length === 1000)).toBe(true);
    expect(query.mock.calls[0]?.[0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[0]?.[1]).toEqual(['contact-member-projection', 'session-1']);
    expect(query).toHaveBeenCalledTimes(9);
  });

  it('seeds contact projection only for inserted or changed members', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ members_fingerprint: 'before' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ participant_id: 'participant-2' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const database = {
      transaction: <T>(operation: (client: { query: typeof query }) => Promise<T>) => operation({ query }),
    } as unknown as DatabaseService;
    const contacts = {
      seedGroupMembers: vi.fn().mockResolvedValue(undefined),
    } as unknown as ContactRepository;
    const participants = [
      { id: 'participant-1', number: 'phone-1', isAdmin: false, isSuperAdmin: false },
      { id: 'participant-2', number: 'phone-2', name: 'Changed', isAdmin: false, isSuperAdmin: false },
    ];

    await new GatewayRepository(database, contacts).upsertGroupDetails('session-1', {
      id: 'group-1', name: 'Group', isAdmin: true, participants,
    });

    expect(contacts.seedGroupMembers).toHaveBeenCalledWith(
      expect.anything(),
      'session-1',
      'group-1',
      [participants[1]],
    );
  });
});
