import { BadRequestException, Controller, Headers, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { runtimeConfig } from '../config/runtime-config';
import { QueueService } from '../queue/queue.service';
import { verifyOpenWASignature } from './webhook-signature';
import { OpenWAWebhookEnvelope, WebhookRepository } from './webhook.repository';

@ApiTags('webhooks')
@Controller('webhooks/openwa')
export class WebhookController {
  constructor(
    private readonly repository: WebhookRepository,
    private readonly queues: QueueService,
  ) {}

  @Public()
  @Post()
  @ApiExcludeEndpoint()
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-openwa-signature') signature: string | undefined,
  ) {
    if (!request.rawBody || !verifyOpenWASignature(request.rawBody, signature, runtimeConfig().OPENWA_WEBHOOK_SECRET)) {
      throw new UnauthorizedException('Invalid OpenWA webhook signature');
    }

    const envelope = request.body as Partial<OpenWAWebhookEnvelope>;
    if (
      !envelope.event ||
      !envelope.timestamp ||
      !envelope.sessionId ||
      !envelope.idempotencyKey ||
      !envelope.deliveryId ||
      !envelope.data
    ) {
      throw new BadRequestException('Invalid OpenWA webhook envelope');
    }

    const typed = envelope as OpenWAWebhookEnvelope;
    const created = await this.repository.insert(typed);
    if (created) {
      await this.queues.webhookIngress.add(
        'process-openwa-webhook',
        { idempotencyKey: typed.idempotencyKey },
        { jobId: typed.idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, '_'), removeOnComplete: 1000, removeOnFail: 5000 },
      );
    }
    return { accepted: true, duplicate: !created };
  }
}
