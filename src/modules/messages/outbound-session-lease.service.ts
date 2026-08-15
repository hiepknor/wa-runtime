import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { MessageJobRepository } from './message-job.repository';
import { OutboundSessionLeaseRepository } from './outbound-session-lease.repository';

export class MessageJobNoLongerProcessingError extends Error {}
export class OutboundSessionLeaseLostError extends Error {}

@Injectable()
export class OutboundSessionLeaseService {
  constructor(
    private readonly leases: OutboundSessionLeaseRepository,
    private readonly messages: MessageJobRepository,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async withLease<T>(
    sessionId: string,
    messageJobId: string,
    operation: (verifyForSend: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const leaseToken = randomUUID();
    const acquisitionTtlMs = this.config.OUTBOUND_MAX_DELAY_MS + 45_000;
    let refreshedAt = Date.now();
    try {
      while (!await this.leases.tryAcquire(sessionId, messageJobId, leaseToken, acquisitionTtlMs)) {
        if (Date.now() - refreshedAt >= 30_000) {
          await this.assertMessageProcessing(messageJobId);
          refreshedAt = Date.now();
        }
        await new Promise(resolve => setTimeout(resolve, 250 + Math.floor(Math.random() * 250)));
      }
      await this.assertMessageProcessing(messageJobId);
      return await operation(async () => {
        if (!await this.leases.renew(sessionId, messageJobId, leaseToken, 45_000)) {
          throw new OutboundSessionLeaseLostError('Outbound session lease lost before send');
        }
        await this.assertMessageProcessing(messageJobId);
      });
    } finally {
      await this.leases.release(sessionId, messageJobId, leaseToken).catch(() => false);
    }
  }

  private async assertMessageProcessing(messageJobId: string): Promise<void> {
    if (!await this.messages.refreshProcessingLease(messageJobId)) {
      throw new MessageJobNoLongerProcessingError('Message job is no longer processing');
    }
  }
}
