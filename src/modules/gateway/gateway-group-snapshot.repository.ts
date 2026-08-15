import { createHash } from 'node:crypto';
import { DatabaseService } from '../../core/database/database.service';
import { acquireSessionTransactionLock } from '../../core/database/session-transaction-lock';
import {
  pendingGroupName,
  type OpenWAGroup,
  type OpenWAGroupSummary,
} from '../../integrations/openwa/openwa.client';
import { ContactRepository } from '../contacts/contact.repository';
import { evaluateGroupCapability, type GroupSendCapabilityStatus } from './group-capability';
import type { GroupIntentWriteFence, SyncItemWriteFence } from './gateway-sync-item.types';
import {
  GatewayWriteFenceRepository,
  type SyncWriteFence,
} from './gateway-write-fence.repository';

interface GroupRow {
  session_id: string;
  id: string;
  name: string;
  description: string | null;
  owner_id: string | null;
  linked_parent_id: string | null;
  participants_count: number | null;
  is_admin: boolean | null;
  is_read_only: boolean | null;
  is_announce: boolean | null;
  settings_locked: boolean | null;
  is_active: boolean;
  details_synced_at: Date | null;
  synced_at: Date;
  send_capability: GroupSendCapabilityStatus;
  send_capability_reason: string;
  capability_checked_at: Date | null;
  capability_invalidated_at: Date | null;
  capability_revision: number;
  capability_refresh_attempt_count: number;
  capability_refresh_lease_token: string | null;
  capability_refresh_lease_expires_at: Date | null;
  capability_refresh_lease_valid?: boolean;
  details_fingerprint: string | null;
  members_fingerprint: string | null;
}

const detailsFingerprint = (group: OpenWAGroup): string => createHash('sha256').update(JSON.stringify({
  id: group.id,
  name: group.name,
  description: group.description ?? null,
  owner: group.owner ?? null,
  linkedParentJID: group.linkedParentJID ?? null,
  isAdmin: group.isAdmin ?? null,
  isReadOnly: group.isReadOnly ?? null,
  isAnnounce: group.announce ?? group.isAnnounce ?? null,
  locked: group.locked ?? null,
  ephemeralSeconds: group.ephemeralSeconds ?? null,
  memberAddMode: group.memberAddMode ?? null,
  participants: [...group.participants]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(participant => ({
      id: participant.id,
      number: participant.number,
      name: participant.name ?? null,
      isAdmin: participant.isAdmin,
      isSuperAdmin: participant.isSuperAdmin,
    })),
})).digest('hex');

const membersFingerprint = (group: OpenWAGroup): string => createHash('sha256').update(JSON.stringify(
  [...group.participants]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(participant => ({
      id: participant.id,
      number: participant.number,
      name: participant.name ?? null,
      isAdmin: participant.isAdmin,
      isSuperAdmin: participant.isSuperAdmin,
    })),
)).digest('hex');

export class GatewayGroupSnapshotRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly contacts: ContactRepository,
    private readonly fences: GatewayWriteFenceRepository,
  ) {}

  async replaceGroupSummaries(
    sessionId: string,
    groups: OpenWAGroupSummary[],
    syncFence: SyncWriteFence,
  ): Promise<void> {
    await this.database.transaction(async client => {
      await this.fences.assertSyncWriteOwnership(client, sessionId, syncFence);
      if (groups.length > 0) {
        await client.query(
          `INSERT INTO gateway_groups
             (session_id, id, name, participants_count, is_admin, linked_parent_id)
           SELECT $1, summary.id, summary.name, summary.participants_count,
             summary.is_admin, summary.linked_parent_id
           FROM jsonb_to_recordset($2::jsonb) AS summary(
             id text, name text, participants_count integer, is_admin boolean, linked_parent_id text
           )
           ON CONFLICT (session_id, id) DO UPDATE SET
             name = CASE WHEN EXCLUDED.name = $3 AND gateway_groups.details_synced_at IS NOT NULL
               THEN gateway_groups.name ELSE EXCLUDED.name END,
             participants_count = COALESCE(EXCLUDED.participants_count, gateway_groups.participants_count),
             is_admin = COALESCE(EXCLUDED.is_admin, gateway_groups.is_admin),
             linked_parent_id = EXCLUDED.linked_parent_id,
             send_capability = CASE WHEN gateway_groups.is_active = false
               THEN 'UNKNOWN' ELSE gateway_groups.send_capability END,
             send_capability_reason = CASE WHEN gateway_groups.is_active = false
               THEN 'GROUP_CHANGED' ELSE gateway_groups.send_capability_reason END,
             capability_invalidated_at = CASE WHEN gateway_groups.is_active = false
               THEN now() ELSE gateway_groups.capability_invalidated_at END,
             capability_revision = CASE WHEN gateway_groups.is_active = false
               THEN gateway_groups.capability_revision + 1 ELSE gateway_groups.capability_revision END,
             is_active = true, synced_at = now(), updated_at = now()`,
          [sessionId, JSON.stringify(groups.map(group => ({
            id: group.id,
            name: group.name,
            participants_count: group.participantsCount ?? null,
            is_admin: group.isAdmin ?? null,
            linked_parent_id: group.linkedParentJID ?? null,
          }))), pendingGroupName],
        );
      }
      await client.query(
        `UPDATE gateway_groups SET is_active = false, updated_at = now()
         WHERE session_id = $1 AND NOT (id = ANY($2::text[]))`,
        [sessionId, groups.map(group => group.id)],
      );
      await client.query(
        `UPDATE gateway_groups SET
           send_capability = 'DENIED', send_capability_reason = 'GROUP_INACTIVE',
           capability_checked_at = now(), capability_invalidated_at = NULL,
           capability_revision = capability_revision + 1, updated_at = now()
         WHERE session_id = $1 AND is_active = false
           AND (send_capability <> 'DENIED' OR send_capability_reason <> 'GROUP_INACTIVE')`,
        [sessionId],
      );
    });
  }

  async upsertGroupDetails(
    sessionId: string,
    group: OpenWAGroup,
    options: {
      expectedRevision?: number;
      capabilityLeaseToken?: string;
      syncFence?: SyncWriteFence;
      syncItemFence?: SyncItemWriteFence;
      groupIntentFence?: GroupIntentWriteFence;
    } = {},
  ): Promise<{ members: number; applied: boolean }> {
    return this.database.transaction(async client => {
      await acquireSessionTransactionLock(client, 'contact-member-projection', sessionId);
      if (options.syncFence) await this.fences.assertSyncWriteOwnership(client, sessionId, options.syncFence);
      if (options.syncItemFence) await this.fences.assertSyncItemWriteOwnership(client, options.syncItemFence);
      if (options.groupIntentFence) await this.fences.assertGroupIntentWriteOwnership(client, options.groupIntentFence);
      const existingResult = await client.query<GroupRow>(
        `SELECT *, capability_refresh_lease_expires_at > now() AS capability_refresh_lease_valid
         FROM gateway_groups WHERE session_id = $1 AND id = $2 FOR UPDATE`,
        [sessionId, group.id],
      );
      const existing = existingResult.rows[0];
      const fingerprint = detailsFingerprint(group);
      const memberFingerprint = membersFingerprint(group);
      const membersChanged = existing?.members_fingerprint !== memberFingerprint;
      if (options.expectedRevision !== undefined && existing?.capability_revision !== options.expectedRevision) {
        return { members: 0, applied: false };
      }
      if (options.capabilityLeaseToken !== undefined
        && (existing?.capability_refresh_lease_token !== options.capabilityLeaseToken
          || existing.capability_refresh_lease_valid !== true)) {
        return { members: 0, applied: false };
      }
      const isAdmin = group.isAdmin ?? existing?.is_admin ?? null;
      const isReadOnly = group.isReadOnly ?? null;
      const isAnnounce = group.announce ?? group.isAnnounce ?? null;
      const capability = evaluateGroupCapability({
        isActive: true,
        isReadOnly,
        isAnnounce,
        isAdmin,
        hasDetails: true,
      });
      await client.query(
        `INSERT INTO gateway_groups
           (session_id, id, name, description, owner_id, linked_parent_id, participants_count,
            is_admin, is_read_only, is_announce, settings_locked, ephemeral_seconds,
            member_add_mode, gateway_created_at, details_synced_at, details_fingerprint,
            members_fingerprint, send_capability,
            send_capability_reason, capability_checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 CASE WHEN $14::bigint IS NULL THEN NULL ELSE to_timestamp($14::bigint) END,
                 now(),$15,$16,$17,$18,now())
         ON CONFLICT (session_id, id) DO UPDATE SET
           name = EXCLUDED.name, description = EXCLUDED.description, owner_id = EXCLUDED.owner_id,
           linked_parent_id = EXCLUDED.linked_parent_id, participants_count = EXCLUDED.participants_count,
           is_admin = COALESCE(EXCLUDED.is_admin, gateway_groups.is_admin),
           is_read_only = EXCLUDED.is_read_only, is_announce = EXCLUDED.is_announce,
           settings_locked = EXCLUDED.settings_locked, ephemeral_seconds = EXCLUDED.ephemeral_seconds,
           member_add_mode = EXCLUDED.member_add_mode, gateway_created_at = EXCLUDED.gateway_created_at,
           details_fingerprint = EXCLUDED.details_fingerprint,
           members_fingerprint = EXCLUDED.members_fingerprint,
           send_capability = EXCLUDED.send_capability,
           send_capability_reason = EXCLUDED.send_capability_reason,
           capability_checked_at = now(), capability_invalidated_at = NULL,
           capability_refresh_attempt_count = 0, capability_refresh_next_attempt_at = now(),
           capability_refresh_lease_token = NULL, capability_refresh_lease_expires_at = NULL,
           capability_refresh_error = NULL,
           capability_revision = CASE
             WHEN gateway_groups.send_capability IS DISTINCT FROM EXCLUDED.send_capability
               OR gateway_groups.send_capability_reason IS DISTINCT FROM EXCLUDED.send_capability_reason
             THEN gateway_groups.capability_revision + 1
             ELSE gateway_groups.capability_revision
           END,
           is_active = true, details_synced_at = now(), synced_at = now(), updated_at = now()`,
        [sessionId, group.id, group.name, group.description ?? null, group.owner ?? null,
          group.linkedParentJID ?? null, group.participants.length, isAdmin,
          isReadOnly, isAnnounce, group.locked ?? null,
          group.ephemeralSeconds ?? null, group.memberAddMode ?? null, group.createdAt ?? null,
          fingerprint, memberFingerprint, capability.status, capability.reason],
      );
      if (membersChanged && group.participants.length > 0) {
        const changedMembers = await client.query<{ participant_id: string }>(
          `INSERT INTO group_members AS existing
             (session_id, group_id, participant_id, phone_number, display_name,
              participant_display_name, display_name_source, display_name_updated_at,
              is_admin, is_super_admin)
           SELECT $1, $2, participant_id, phone_number, participant_display_name,
             participant_display_name,
             CASE WHEN participant_display_name IS NULL THEN NULL ELSE 'GROUP_PARTICIPANT_NAME' END,
             CASE WHEN participant_display_name IS NULL THEN NULL ELSE now() END,
             is_admin, is_super_admin
           FROM unnest($3::text[], $4::text[], $5::text[], $6::boolean[], $7::boolean[])
             AS participant(participant_id, phone_number, participant_display_name, is_admin, is_super_admin)
           ON CONFLICT (session_id, group_id, participant_id) DO UPDATE SET
             phone_number = EXCLUDED.phone_number,
             participant_display_name = EXCLUDED.participant_display_name,
             is_admin = EXCLUDED.is_admin,
             is_super_admin = EXCLUDED.is_super_admin,
             synced_at = now(), updated_at = now()
           WHERE (existing.phone_number, existing.participant_display_name,
                  existing.is_admin, existing.is_super_admin)
             IS DISTINCT FROM
             (EXCLUDED.phone_number, EXCLUDED.participant_display_name,
              EXCLUDED.is_admin, EXCLUDED.is_super_admin)
           RETURNING existing.participant_id`,
          [
            sessionId,
            group.id,
            group.participants.map(participant => participant.id),
            group.participants.map(participant => participant.number),
            group.participants.map(participant => participant.name ?? null),
            group.participants.map(participant => participant.isAdmin),
            group.participants.map(participant => participant.isSuperAdmin),
          ],
        );
        const changedParticipantIds = new Set(changedMembers.rows.map(row => row.participant_id));
        await this.contacts.seedGroupMembers(
          client,
          sessionId,
          group.id,
          group.participants.filter(participant => changedParticipantIds.has(participant.id)),
        );
      }
      if (membersChanged) {
        await client.query(
          `DELETE FROM group_members WHERE session_id = $1 AND group_id = $2
             AND NOT (participant_id = ANY($3::text[]))`,
          [sessionId, group.id, group.participants.map(participant => participant.id)],
        );
      }
      if (options.syncItemFence) {
        const renewed = await client.query(
          `UPDATE gateway_sync_items SET lease_expires_at = clock_timestamp() + interval '2 minutes',
             updated_at = clock_timestamp()
           WHERE id = $1 AND status = 'RUNNING' AND lease_token = $2`,
          [options.syncItemFence.itemId, options.syncItemFence.leaseToken],
        );
        if (renewed.rowCount !== 1) throw new Error('Gateway sync item lost write ownership');
        await this.fences.renewGroupReadPacingLease(
          client,
          sessionId,
          options.syncItemFence.leaseToken,
        );
      }
      if (options.groupIntentFence) {
        const renewed = await client.query(
          `UPDATE gateway_group_reconciliation_intents
           SET lease_expires_at = clock_timestamp() + interval '2 minutes', updated_at = clock_timestamp()
           WHERE session_id = $1 AND group_id = $2 AND status = 'RUNNING'
             AND lease_token = $3 AND claimed_revision = $4`,
          [options.groupIntentFence.sessionId, options.groupIntentFence.groupId,
            options.groupIntentFence.leaseToken, options.groupIntentFence.claimedRevision],
        );
        if (renewed.rowCount !== 1) throw new Error('Gateway group intent lost write ownership');
        await this.fences.renewGroupReadPacingLease(
          client,
          sessionId,
          options.groupIntentFence.leaseToken,
        );
      }
      return { members: group.participants.length, applied: true };
    });
  }
}
