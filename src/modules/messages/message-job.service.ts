import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateMessageJobDto } from '../../contracts/messages/create-message-job.dto';
import { SessionScopeService } from '../gateway/session-scope.service';
import { messageRequestHash } from './message-idempotency';
import { MessageJobRepository } from './message-job.repository';
import { MessageSendPolicyService } from './message-send-policy.service';

@Injectable()
export class MessageJobService {
  constructor(
    private readonly repository: MessageJobRepository,
    private readonly policy: MessageSendPolicyService,
    private readonly sessions: SessionScopeService,
  ) {}

  async create(idempotencyKey: string, dto: CreateMessageJobDto) {
    if (idempotencyKey.length > 200) throw new BadRequestException('Idempotency-Key must not exceed 200 characters');
    await this.policy.assertCreatable(dto.sessionId, dto.recipientId, dto.dryRun);
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : new Date();
    if (scheduledAt.getTime() < Date.now() - 60_000) {
      throw new ConflictException('scheduledAt is more than 60 seconds in the past');
    }
    const result = await this.repository.create({
      idempotencyScope: 'runtime-api',
      idempotencyKey,
      requestHash: messageRequestHash({
        sessionId: dto.sessionId,
        recipientId: dto.recipientId,
        text: dto.text,
        scheduledAt: dto.scheduledAt ?? null,
        dryRun: dto.dryRun,
      }),
      sessionId: dto.sessionId,
      recipientId: dto.recipientId,
      text: dto.text,
      scheduledAt,
      dryRun: dto.dryRun,
    });
    if (result.idempotencyConflict) {
      throw new ConflictException('Idempotency-Key was already used with a different message request');
    }
    return result;
  }

  async get(id: string) {
    const job = await this.repository.find(id);
    if (!job) throw new NotFoundException('Message job not found');
    this.sessions.assertVisible(job.sessionId);
    return job;
  }
}
