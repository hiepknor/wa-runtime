import { Injectable } from '@nestjs/common';
import { runtimeConfig } from '../config/runtime-config';

export interface OpenWASendTextResult {
  messageId: string;
  timestamp: number;
}

export class OpenWAHttpError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`OpenWA returned HTTP ${status}`);
  }
}

@Injectable()
export class OpenWAClient {
  private readonly config = runtimeConfig();

  async sendText(sessionId: string, chatId: string, text: string): Promise<OpenWASendTextResult> {
    const url = new URL(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`,
      this.config.OPENWA_BASE_URL,
    );
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.OPENWA_API_KEY,
      },
      body: JSON.stringify({ chatId, text }),
    });

    if (!response.ok) {
      throw new OpenWAHttpError(response.status, await response.text());
    }
    return (await response.json()) as OpenWASendTextResult;
  }
}
