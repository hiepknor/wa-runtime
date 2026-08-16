import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { CreateGroupListDto } from '../../contracts/group-lists/create-group-list.dto';
import type { GroupListQueryDto } from '../../contracts/group-lists/group-list-query.dto';
import type { UpdateGroupListDto } from '../../contracts/group-lists/update-group-list.dto';
import { SessionScopeService } from '../gateway/session-scope.service';
import { GroupListError } from './group-list-error';
import { GroupListRepository } from './group-list.repository';

@Injectable()
export class GroupListService {
  constructor(
    private readonly repository: GroupListRepository,
    private readonly sessions: SessionScopeService,
  ) {}

  async list(query: GroupListQueryDto) {
    this.sessions.assertVisible(query.sessionId);
    const normalizedQuery = query.query?.trim();
    const result = await this.repository.list({
      sessionId: query.sessionId,
      query: normalizedQuery || undefined,
      limit: query.limit,
      offset: query.offset,
    });
    return { data: result.data, meta: { total: result.total, limit: query.limit, offset: query.offset } };
  }

  async create(dto: CreateGroupListDto, rawIdempotencyKey: string | undefined) {
    this.sessions.assertAllowed(dto.sessionId);
    const idempotencyKey = rawIdempotencyKey?.trim();
    if (!idempotencyKey) {
      throw new GroupListError(HttpStatus.BAD_REQUEST, 'GROUP_LIST_IDEMPOTENCY_KEY_REQUIRED',
        'Idempotency-Key header is required');
    }
    if (!isUUID(idempotencyKey)) {
      throw new GroupListError(HttpStatus.BAD_REQUEST, 'GROUP_LIST_IDEMPOTENCY_KEY_INVALID',
        'Idempotency-Key must be a UUID');
    }
    const groupIds = dto.groupIds ?? [];
    this.validateGroupIds(groupIds);
    const name = this.normalizeName(dto.name);
    const description = this.normalizeDescription(dto.description);
    const requestHash = createHash('sha256').update(JSON.stringify({
      sessionId: dto.sessionId,
      name,
      description,
      groupIds: [...groupIds].sort(),
    })).digest('hex');
    const result = await this.repository.create({
        sessionId: dto.sessionId,
        name,
        description,
        groupIds: [...groupIds].sort(),
        idempotencyKey,
        requestHash,
      }).catch(error => this.rethrowPersistenceError(error));
    if (!result.sessionFound) {
      throw new GroupListError(HttpStatus.UNPROCESSABLE_ENTITY, 'GROUP_LIST_SESSION_NOT_FOUND',
        'Session is not synchronized');
    }
    this.throwGroupValidation(result);
    if (result.requestHash !== requestHash) {
      throw new GroupListError(HttpStatus.CONFLICT, 'GROUP_LIST_IDEMPOTENCY_CONFLICT',
        'Idempotency-Key was already used with a different group-list payload');
    }
    if (result.list?.archivedAt) {
      throw new GroupListError(HttpStatus.CONFLICT, 'GROUP_LIST_IDEMPOTENCY_KEY_RETIRED',
        'Idempotency-Key belongs to an archived saved group list and cannot be reused');
    }
    return { list: result.list!, created: result.created };
  }

  async get(id: string) {
    const list = await this.repository.find(id);
    if (!list || !this.sessions.isAllowed(list.sessionId)) this.notFound();
    return list!;
  }

  async update(id: string, dto: UpdateGroupListDto) {
    const current = await this.getForMutation(id);
    this.assertExpectedRevision(dto.expectedRevision, current.revision);
    const name = dto.name === undefined ? current.name : this.normalizeName(dto.name);
    const description = dto.description === undefined
      ? current.description
      : this.normalizeDescription(dto.description);
    const updated = await this.repository.update(id, { name, description }, current.revision)
      .catch(error => this.rethrowPersistenceError(error));
    if (!updated) await this.throwMutationRace(id, current.revision);
    return updated;
  }

  async archive(id: string, expectedRevision?: number): Promise<void> {
    const current = await this.repository.find(id, true);
    if (!current || !this.sessions.isAllowed(current.sessionId)) this.notFound();
    if (current.archivedAt) return;
    this.assertExpectedRevision(expectedRevision, current.revision);
    const archived = await this.repository.archive(id, current.revision);
    if (archived) return;
    const latest = await this.repository.find(id, true);
    if (!latest || !this.sessions.isAllowed(latest.sessionId)) this.notFound();
    if (latest.archivedAt) return;
    this.revisionConflict(current.revision, latest.revision);
  }

  async membership(id: string) {
    const membership = await this.repository.getMembership(id);
    if (!membership || !this.sessions.isAllowed(membership.list.sessionId)) this.notFound();
    return { list: membership.list, data: membership.groups };
  }

  async replaceGroups(
    id: string,
    groupIds: string[],
    expectedRevision?: number,
    expectedMembershipRevision?: number,
  ) {
    const current = await this.getForMutation(id);
    this.assertExpectedRevision(expectedRevision, current.revision);
    if (expectedMembershipRevision !== undefined
      && expectedMembershipRevision !== current.membershipRevision) {
      this.revisionConflict(expectedMembershipRevision, current.membershipRevision);
    }
    this.validateGroupIds(groupIds);
    const result = await this.repository.replaceGroups(
      id,
      [...groupIds].sort(),
      current.revision,
      expectedMembershipRevision,
    );
    if (result.revisionConflict) this.revisionConflict(current.revision);
    this.throwGroupValidation(result);
    if (!result.list || !result.groups) this.notFound();
    return { list: result.list!, data: result.groups! };
  }

  private validateGroupIds(groupIds: string[]): void {
    if (groupIds.length > 1000) {
      throw new GroupListError(HttpStatus.UNPROCESSABLE_ENTITY, 'GROUP_LIST_GROUP_LIMIT_EXCEEDED',
        'A saved group list can contain at most 1000 unique groups', { maximum: 1000 });
    }
    if (new Set(groupIds).size !== groupIds.length) {
      throw new GroupListError(HttpStatus.UNPROCESSABLE_ENTITY, 'GROUP_LIST_GROUP_DUPLICATE',
        'Duplicate group IDs are not allowed');
    }
  }

  private throwGroupValidation(result: {
    missingGroupIds: string[];
    mismatchedGroupIds: string[];
  }): void {
    if (result.mismatchedGroupIds.length) {
      throw new GroupListError(HttpStatus.UNPROCESSABLE_ENTITY, 'GROUP_LIST_GROUP_SESSION_MISMATCH',
        'One or more groups do not belong to the saved list session',
        { invalidGroupCount: result.mismatchedGroupIds.length });
    }
    if (result.missingGroupIds.length) {
      throw new GroupListError(HttpStatus.UNPROCESSABLE_ENTITY, 'GROUP_LIST_GROUP_NOT_FOUND',
        'One or more groups are not present in the durable group read model',
        { invalidGroupCount: result.missingGroupIds.length });
    }
  }

  private normalizeName(value: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new GroupListError(HttpStatus.BAD_REQUEST, 'GROUP_LIST_NAME_INVALID',
        'name must not be blank', undefined, { name: ['Must not be blank.'] });
    }
    return normalized;
  }

  private normalizeDescription(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    return value.trim() || null;
  }

  private rethrowPersistenceError(error: unknown): never {
    const databaseError = error as { code?: string; constraint?: string };
    if (databaseError.code === '23505' && databaseError.constraint === 'uq_group_lists_active_session_name') {
      throw new GroupListError(HttpStatus.CONFLICT, 'GROUP_LIST_NAME_CONFLICT',
        'An active saved group list with this name already exists in the session',
        undefined, { name: ['Must be unique within the session.'] });
    }
    throw error;
  }

  private async getForMutation(id: string) {
    const list = await this.repository.find(id, true);
    if (!list || !this.sessions.isAllowed(list.sessionId)) this.notFound();
    if (list.archivedAt) {
      throw new GroupListError(HttpStatus.CONFLICT, 'GROUP_LIST_ARCHIVED',
        'Archived saved group lists cannot be changed');
    }
    return list;
  }

  private assertExpectedRevision(expectedRevision: number | undefined, currentRevision: number): void {
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      this.revisionConflict(expectedRevision, currentRevision);
    }
  }

  private async throwMutationRace(id: string, expectedRevision: number): Promise<never> {
    const latest = await this.repository.find(id, true);
    if (!latest || !this.sessions.isAllowed(latest.sessionId)) this.notFound();
    if (latest.archivedAt) {
      throw new GroupListError(HttpStatus.CONFLICT, 'GROUP_LIST_ARCHIVED',
        'Archived saved group lists cannot be changed');
    }
    return this.revisionConflict(expectedRevision, latest.revision);
  }

  private revisionConflict(expectedRevision: number, currentRevision?: number): never {
    throw new GroupListError(HttpStatus.CONFLICT, 'GROUP_LIST_REVISION_CONFLICT',
      'Saved group list changed after it was loaded', {
        expectedRevision, ...(currentRevision === undefined ? {} : { currentRevision }),
      });
  }

  private notFound(): never {
    throw new GroupListError(HttpStatus.NOT_FOUND, 'GROUP_LIST_NOT_FOUND', 'Saved group list not found');
  }
}
