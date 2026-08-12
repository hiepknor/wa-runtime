import { Injectable, Logger } from '@nestjs/common';
import { runtimeConfig } from '../../core/config/runtime-config';

export interface OpenWASendTextResult {
  messageId: string;
  timestamp: number;
}

export type OpenWASessionStatus =
  | 'created'
  | 'initializing'
  | 'qr_ready'
  | 'authenticating'
  | 'ready'
  | 'disconnected'
  | 'action_required'
  | 'failed';

export interface OpenWASession {
  id: string;
  name: string;
  status: OpenWASessionStatus;
  phone?: string | null;
  pushName?: string | null;
  connectedAt?: string | null;
  lastActive?: string | null;
  createdAt: string;
  updatedAt: string;
  lastError?: string | null;
  restriction?: Record<string, unknown> | null;
  engineLoaded: boolean;
}

export interface OpenWAGroupSummary {
  id: string;
  name: string;
  participantsCount?: number;
  isAdmin?: boolean;
  linkedParentJID?: string | null;
}

export interface OpenWAGroupParticipant {
  id: string;
  number: string;
  name?: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export interface OpenWAGroup extends OpenWAGroupSummary {
  description?: string;
  owner?: string;
  createdAt?: number;
  participants: OpenWAGroupParticipant[];
  isReadOnly?: boolean;
  isAnnounce?: boolean;
  announce?: boolean;
  locked?: boolean;
  ephemeralSeconds?: number;
  memberAddMode?: 'all' | 'admins';
}

export interface OpenWAWebhook {
  id: string;
  sessionId: string;
  url: string;
  events: string[];
  active: boolean;
}

export interface OpenWAHealth {
  status: string;
  timestamp: string;
  version: string;
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
  private readonly logger = new Logger(OpenWAClient.name);

  private async request<T>(operation: string, path: string, init?: RequestInit): Promise<T> {
    const started = performance.now();
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    headers.set('accept', 'application/json');
    headers.set('x-api-key', this.config.OPENWA_API_KEY);
    try {
      const response = await fetch(new URL(path, this.config.OPENWA_BASE_URL), {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers,
      });
      if (!response.ok) throw new OpenWAHttpError(response.status, await response.text());
      this.logger.debug({
        event: 'openwa.request.completed', operation, method, statusCode: response.status,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      });
      return (await response.json()) as T;
    } catch (error) {
      this.logger.error({
        event: 'openwa.request.failed', operation, method,
        statusCode: error instanceof OpenWAHttpError ? error.status : undefined,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        error,
      });
      throw error;
    }
  }

  listSessions(): Promise<OpenWASession[]> {
    return this.request('list_sessions', '/api/sessions?limit=1000');
  }

  async assertCompatibleRelease(): Promise<void> {
    const health = await this.request<OpenWAHealth>('health', '/api/health');
    if (health.version !== this.config.OPENWA_RELEASE_TAG) {
      throw new Error(
        `OpenWA release mismatch: expected ${this.config.OPENWA_RELEASE_TAG}, received ${health.version}`,
      );
    }
  }

  getSession(sessionId: string): Promise<OpenWASession> {
    return this.request('get_session', `/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  async listGroups(sessionId: string): Promise<OpenWAGroupSummary[]> {
    const pageSize = 1000;
    const groups: OpenWAGroupSummary[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.request<OpenWAGroupSummary[]>('list_groups',
        `/api/sessions/${encodeURIComponent(sessionId)}/groups?limit=${pageSize}&offset=${offset}`,
      );
      groups.push(...page);
      if (page.length < pageSize) return groups;
    }
  }

  getGroup(sessionId: string, groupId: string): Promise<OpenWAGroup> {
    return this.request('get_group',
      `/api/sessions/${encodeURIComponent(sessionId)}/groups/${encodeURIComponent(groupId)}`,
    );
  }

  listWebhooks(sessionId: string): Promise<OpenWAWebhook[]> {
    return this.request('list_webhooks', `/api/sessions/${encodeURIComponent(sessionId)}/webhooks`);
  }

  registerWebhook(input: {
    sessionId: string;
    url: string;
    events: string[];
    secret: string;
  }): Promise<OpenWAWebhook> {
    return this.request('register_webhook', `/api/sessions/${encodeURIComponent(input.sessionId)}/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: input.url, events: input.events, secret: input.secret }),
    });
  }

  async sendText(sessionId: string, chatId: string, text: string): Promise<OpenWASendTextResult> {
    return this.request('send_text', `/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ chatId, text }),
    });
  }
}
