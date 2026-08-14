import { Injectable, Logger } from '@nestjs/common';
import { ContactResolutionRepository } from './contact-resolution.repository';

export interface ContactResolutionOptions {
  enabled: boolean;
  maxRunsPerTick: number;
}

@Injectable()
export class ContactResolutionTick {
  private readonly logger = new Logger(ContactResolutionTick.name);

  constructor(
    private readonly repository: ContactResolutionRepository,
    private readonly options: ContactResolutionOptions,
  ) {}

  async run(): Promise<void> {
    if (!this.options.enabled) return;
    await this.repository.enqueuePublished(this.options.maxRunsPerTick * 2);
    for (let index = 0; index < this.options.maxRunsPerTick; index += 1) {
      const claim = await this.repository.claim();
      if (!claim) return;
      try {
        const result = await this.repository.resolve(claim);
        this.logger.log({ event: 'contacts.resolution.completed', ...result });
      } catch (error) {
        await this.repository.fail(claim).catch(() => undefined);
        this.logger.warn({ event: 'contacts.resolution.failed' });
        throw error;
      }
    }
  }
}
