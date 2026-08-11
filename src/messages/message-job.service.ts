import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateMessageJobDto } from './create-message-job.dto';
import { MessageJobRepository } from './message-job.repository';

@Injectable()
export class MessageJobService {
  constructor(private readonly repository: MessageJobRepository) {}

  async create(idempotencyKey: string, dto: CreateMessageJobDto) {
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : new Date();
    if (scheduledAt.getTime() < Date.now() - 60_000) {
      throw new ConflictException('scheduledAt is more than 60 seconds in the past');
    }
    return this.repository.create({
      idempotencyKey,
      sessionId: dto.sessionId,
      recipientId: dto.recipientId,
      text: dto.text,
      scheduledAt,
      dryRun: dto.dryRun,
    });
  }

  async get(id: string) {
    const job = await this.repository.find(id);
    if (!job) throw new NotFoundException('Message job not found');
    return job;
  }
}
