import { Body, Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CreateMessageJobDto } from '../../contracts/messages/create-message-job.dto';
import { MessageJobService } from './message-job.service';

@ApiTags('message-jobs')
@ApiSecurity('runtime-key')
@Controller('message-jobs')
export class MessageJobController {
  constructor(private readonly service: MessageJobService) {}

  @Post()
  @ApiOperation({ summary: 'Create an idempotent scheduled text-message job' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateMessageJobDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey?.trim()) {
      response.status(400);
      return { statusCode: 400, message: 'Idempotency-Key header is required' };
    }
    const result = await this.service.create(idempotencyKey.trim(), dto);
    response.status(result.created ? 201 : 200);
    return result.job;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read current durable message-job state' })
  get(@Param('id') id: string) {
    return this.service.get(id);
  }
}
