import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ContactRepository } from './contact.repository';
import { ContactMessageObservationIntentRepository } from './contact-message-observation-intent.repository';

@Injectable()
export class ContactMessageObserverService {
  constructor(
    private readonly repository: ContactRepository,
    private readonly intents: ContactMessageObservationIntentRepository,
    private readonly enabled: boolean,
  ) {}

  async enqueue(
    client: PoolClient,
    input: {
      eventId: string;
      sessionId: string;
      senderId: string;
      pushName: string;
      observedAt: Date;
    },
  ): Promise<boolean> {
    if (!this.enabled) return false;
    return this.intents.enqueue(client, input);
  }

  async observe(
    sessionId: string,
    senderId: string,
    pushName: string,
    observedAt: Date,
    observationKey: string,
  ): Promise<boolean> {
    if (!this.enabled) return false;
    return this.repository.observeMessageSender(
      sessionId,
      senderId,
      pushName,
      observedAt,
      observationKey,
    );
  }
}
