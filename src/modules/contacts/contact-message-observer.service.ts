import { Injectable } from '@nestjs/common';
import { ContactRepository } from './contact.repository';

@Injectable()
export class ContactMessageObserverService {
  constructor(
    private readonly repository: ContactRepository,
    private readonly enabled: boolean,
  ) {}

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
