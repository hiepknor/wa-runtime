import { Injectable } from '@nestjs/common';
import { runtimeConfig } from '../config/runtime-config';

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

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(new URL(path, this.config.OPENWA_BASE_URL), {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: 'application/json',
        'x-api-key': this.config.OPENWA_API_KEY,
        ...init?.headers,
      },
    });
    if (!response.ok) throw new OpenWAHttpError(response.status, await response.text());
    return (await response.json()) as T;
  }

  listSessions(): Promise<OpenWASession[]> {
    return this.request('/api/sessions?limit=1000');
  }

  async assertCompatibleRelease(): Promise<void> {
    const health = await this.request<OpenWAHealth>('/api/health');
    if (health.version !== this.config.OPENWA_RELEASE_TAG) {
      throw new Error(
        `OpenWA release mismatch: expected ${this.config.OPENWA_RELEASE_TAG}, received ${health.version}`,
      );
    }
  }

  getSession(sessionId: string): Promise<OpenWASession> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  listGroups(sessionId: string): Promise<OpenWAGroupSummary[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/groups?limit=1000`);
  }

  getGroup(sessionId: string, groupId: string): Promise<OpenWAGroup> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/groups/${encodeURIComponent(groupId)}`,
    );
  }

  listWebhooks(sessionId: string): Promise<OpenWAWebhook[]> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/webhooks`);
  }

  registerWebhook(input: {
    sessionId: string;
    url: string;
    events: string[];
    secret: string;
  }): Promise<OpenWAWebhook> {
    return this.request(`/api/sessions/${encodeURIComponent(input.sessionId)}/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: input.url, events: input.events, secret: input.secret }),
    });
  }

  async sendText(sessionId: string, chatId: string, text: string): Promise<OpenWASendTextResult> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ chatId, text }),
    });
  }
}
