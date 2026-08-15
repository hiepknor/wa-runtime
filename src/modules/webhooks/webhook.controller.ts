import { BadRequestException, Controller, Headers, Inject, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../core/auth/public.decorator';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { QueueService } from '../../core/queue/queue.service';
import { stableQueueJobId } from '../../core/queue/queue-job-id';
import { SessionScopeService } from '../gateway/session-scope.service';
import { verifyOpenWASignature } from './webhook-signature';
import { OpenWAWebhookEnvelope, WebhookRepository } from './webhook.repository';

@ApiTags('webhooks')
@Controller('webhooks/openwa')
export class WebhookController {
  constructor(
    private readonly repository: WebhookRepository,
    private readonly queues: QueueService,
    private readonly sessions: SessionScopeService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  @Public()
  @Post()
  @ApiExcludeEndpoint()
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-openwa-signature') signature: string | undefined,
  ) {
    if (!request.rawBody || !verifyOpenWASignature(request.rawBody, signature, this.config.OPENWA_WEBHOOK_SECRET)) {
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
    this.sessions.assertAllowed(typed.sessionId);
    const created = await this.repository.insert(typed);
    await this.queues.webhookIngress.add(
      'process-openwa-webhook',
      { idempotencyKey: typed.idempotencyKey },
      { jobId: stableQueueJobId('webhook', typed.idempotencyKey), attempts: 1, removeOnComplete: true, removeOnFail: true },
    );
    return { accepted: true, duplicate: !created };
  }
}
