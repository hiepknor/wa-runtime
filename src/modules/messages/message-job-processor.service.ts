import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { DatabaseService } from '../../core/database/database.service';
import { OpenWAClient, OpenWAHttpError } from '../../integrations/openwa/openwa.client';
import { GatewayRepository } from '../gateway/gateway.repository';
import { MessageJobRepository } from './message-job.repository';
import { MessageSendPolicyService } from './message-send-policy.service';
import type { MessageJobStatus, MessageSendQueuePayload } from './message-job.types';
import { MessageJobNoLongerProcessingError, OutboundSessionLeaseService } from './outbound-session-lease.service';

const randomDelay = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

const isDefinitiveUpstreamRejection = (error: unknown): boolean =>
  error instanceof OpenWAHttpError
  && error.status >= 400
  && error.status < 500
  && error.status !== 408;

@Injectable()
export class MessageJobProcessorService {
  constructor(
    private readonly database: DatabaseService,
    private readonly messages: MessageJobRepository,
    private readonly policy: MessageSendPolicyService,
    private readonly openwa: OpenWAClient,
    private readonly gateway: GatewayRepository,
    private readonly outboundSessions: OutboundSessionLeaseService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async process(payload: MessageSendQueuePayload): Promise<unknown> {
    const job = await this.messages.markProcessing(payload.messageJobId);
    if (!job) return { skipped: true };

    if (job.dryRun) {
      await this.update(job.id, 'DRY_RUN_COMPLETED', { response: { dryRun: true } });
      return { dryRun: true };
    }

    if (!this.config.ALLOW_LIVE_SENDS) {
      const error = 'Live send blocked: ALLOW_LIVE_SENDS=false';
      await this.update(job.id, 'FAILED', { error });
      throw new Error(error);
    }

    const blockReason = await this.policy.liveBlockReason(job.sessionId, job.recipientId);
    if (blockReason) {
      await this.update(job.id, 'FAILED', { error: `Live send blocked: ${blockReason}` });
      throw new Error(`Live send blocked: ${blockReason}`);
    }

    let upstreamStarted = false;
    try {
      return await this.outboundSessions.withLease(
        job.sessionId,
        job.id,
        async verifyForSend => {
          await new Promise(resolve =>
            setTimeout(resolve, randomDelay(this.config.OUTBOUND_MIN_DELAY_MS, this.config.OUTBOUND_MAX_DELAY_MS)),
          );
          await verifyForSend();
          upstreamStarted = true;
          const result = await this.openwa.sendText(job.sessionId, job.recipientId, job.payload.text);
          await this.update(job.id, 'ACCEPTED', { openwaMessageId: result.messageId, response: result });
          return result;
        },
      );
    } catch (error) {
      if (error instanceof MessageJobNoLongerProcessingError) return { skipped: true };
      // Once the POST starts, only an explicit client-error response proves that OpenWA rejected
      // the request. A timeout, malformed success response or 5xx may have happened after WhatsApp
      // accepted the message, so retrying it would risk a duplicate send.
      const status: MessageJobStatus = !upstreamStarted || isDefinitiveUpstreamRejection(error)
        ? 'FAILED'
        : 'UNKNOWN';
      const description = error instanceof Error ? error.message : String(error);
      await this.update(job.id, status, { error: description });
      if (error instanceof OpenWAHttpError && job.recipientId.endsWith('@g.us')) {
        if (error.status === 403) {
          await this.gateway.invalidateGroupCapability(job.sessionId, job.recipientId, 'GATEWAY_PERMISSION_DENIED');
        } else if (error.status === 404) {
          await this.gateway.invalidateGroupCapability(job.sessionId, job.recipientId, 'GROUP_CHANGED');
        }
      }
      throw error;
    }
  }

  private update(
    id: string,
    status: MessageJobStatus,
    options: { openwaMessageId?: string; error?: string; response?: unknown },
  ): Promise<void> {
    return this.database.transaction((client: PoolClient) => this.messages.updateResult(client, id, status, options));
  }
}
