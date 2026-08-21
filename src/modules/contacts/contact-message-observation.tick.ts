import { Injectable, Logger } from '@nestjs/common';
import { ContactMessageObservationIntentRepository } from './contact-message-observation-intent.repository';
import { ContactMessageObserverService } from './contact-message-observer.service';

export interface ContactMessageObservationOptions {
  enabled: boolean;
  maxPerTick: number;
}

@Injectable()
export class ContactMessageObservationTick {
  private readonly logger = new Logger(ContactMessageObservationTick.name);

  constructor(
    private readonly intents: ContactMessageObservationIntentRepository,
    private readonly observer: ContactMessageObserverService,
    private readonly options: ContactMessageObservationOptions,
  ) {}

  async run(): Promise<void> {
    if (!this.options.enabled) return;
    const recovered = await this.intents.recoverExpired();
    const claims = await this.intents.claim(this.options.maxPerTick);
    let completed = 0;
    let retried = 0;
    let dead = 0;
    let lostOwnership = 0;
    for (const claim of claims) {
      try {
        await this.observer.observe(
          claim.sessionId,
          claim.senderId,
          claim.pushName,
          claim.observedAt,
          claim.eventId,
        );
        if (await this.intents.complete(claim.eventId, claim.leaseToken)) completed += 1;
        else lostOwnership += 1;
      } catch (error) {
        const result = await this.intents.fail(
          claim.eventId,
          claim.leaseToken,
          error instanceof Error ? error.message : String(error),
        );
        if (result === 'RETRY') retried += 1;
        else if (result === 'DEAD') dead += 1;
        else lostOwnership += 1;
      }
    }
    if (recovered > 0 || claims.length > 0) {
      this.logger.log({
        event: 'contacts.message_observation.completed',
        claimed: claims.length,
        completed,
        retried,
        dead,
        recovered,
        lostOwnership,
      });
    }
  }
}
