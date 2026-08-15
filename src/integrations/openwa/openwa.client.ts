import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';

export type OpenWASessionStatus =
  | 'created'
  | 'initializing'
  | 'qr_ready'
  | 'authenticating'
  | 'ready'
  | 'disconnected'
  | 'action_required'
  | 'failed';

const nonEmptyString = z.string().min(1);
const nullableString = z.string().nullable().optional();
const dateTimeString = z.string().refine(value => Number.isFinite(Date.parse(value)), 'invalid datetime');
const nullableDateTimeString = dateTimeString.nullable().optional();
const sessionStatusSchema = z.enum([
  'created', 'initializing', 'qr_ready', 'authenticating', 'ready',
  'disconnected', 'action_required', 'failed',
]);
const sessionSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  status: sessionStatusSchema,
  phone: nullableString,
  pushName: nullableString,
  connectedAt: nullableDateTimeString,
  lastActive: nullableDateTimeString,
  createdAt: dateTimeString,
  updatedAt: dateTimeString,
  lastError: nullableString,
  restriction: z.record(z.string(), z.unknown()).nullable().optional(),
  engineLoaded: z.boolean(),
});
export const pendingGroupName = 'Group subject pending sync';
const groupSummaryBaseSchema = z.object({
  id: nonEmptyString,
  name: z.string().optional(),
  participantsCount: z.number().int().nonnegative().optional(),
  isAdmin: z.boolean().optional(),
  linkedParentJID: nullableString,
});
const groupSummarySchema = groupSummaryBaseSchema.transform(summary => ({
  ...summary,
  name: summary.name?.trim() ? summary.name : pendingGroupName,
}));
const participantSchema = z.object({
  id: nonEmptyString,
  number: nonEmptyString,
  name: nullableString,
  isAdmin: z.boolean(),
  isSuperAdmin: z.boolean(),
});
const contactSchema = z.object({
  id: nonEmptyString,
  number: z.string(),
  name: z.string().nullish(),
  pushName: z.string().nullish(),
  isMyContact: z.boolean(),
  isBlocked: z.boolean(),
  profilePicUrl: z.string().nullish(),
});
const groupSchema = groupSummaryBaseSchema.extend({
  description: nullableString,
  owner: nullableString,
  createdAt: z.number().int().optional(),
  participants: z.array(participantSchema).max(100_000),
  isReadOnly: z.boolean().optional(),
  isAnnounce: z.boolean().optional(),
  announce: z.boolean().optional(),
  locked: z.boolean().optional(),
  ephemeralSeconds: z.number().int().nonnegative().optional(),
  memberAddMode: z.enum(['all', 'admins']).optional(),
}).superRefine((group, context) => {
  const participantIds = new Set<string>();
  for (const participant of group.participants) {
    if (participantIds.has(participant.id)) {
      context.addIssue({
        code: 'custom',
        path: ['participants'],
        message: 'duplicate participant id',
      });
      return;
    }
    participantIds.add(participant.id);
  }
}).transform(group => ({
  ...group,
  name: group.name?.trim() ? group.name : pendingGroupName,
}));
const webhookSchema = z.object({
  id: nonEmptyString,
  sessionId: nonEmptyString,
  url: z.url(),
  events: z.array(nonEmptyString),
  active: z.boolean(),
  retryCount: z.number().int().min(0).max(5),
});
const healthSchema = z.object({ status: nonEmptyString, timestamp: dateTimeString, version: nonEmptyString });
const sendTextResultSchema = z.object({ messageId: nonEmptyString, timestamp: z.number().int().nonnegative() });
const maxRateLimitRetries = 12;
const maxTransientReadRetries = 4;

export type OpenWASendTextResult = z.infer<typeof sendTextResultSchema>;
export type OpenWASession = z.infer<typeof sessionSchema>;
export type OpenWAGroupSummary = z.infer<typeof groupSummarySchema>;
export type OpenWAGroupParticipant = z.infer<typeof participantSchema>;
export type OpenWAGroup = z.infer<typeof groupSchema>;
export type OpenWAContact = z.infer<typeof contactSchema>;
export type OpenWAWebhook = z.infer<typeof webhookSchema>;
export type OpenWAHealth = z.infer<typeof healthSchema>;

export class OpenWAHttpError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
    readonly retryAfterMs?: number,
  ) {
    super(`OpenWA returned HTTP ${status}`);
    this.name = 'OpenWAHttpError';
  }
}

export class OpenWAResponseValidationError extends Error {
  constructor(readonly operation: string, readonly issues: number) {
    super(`OpenWA returned an invalid ${operation} response (${issues} schema issues)`);
    this.name = 'OpenWAResponseValidationError';
  }
}

@Injectable()
export class OpenWAClient {
  private readonly logger = new Logger(OpenWAClient.name);

  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig()) {}

  private async request<T>(operation: string, path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const started = performance.now();
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    headers.set('accept', 'application/json');
    headers.set('x-api-key', this.config.OPENWA_API_KEY);
    try {
      let rateLimitRetries = 0;
      let transientRetries = 0;
      for (;;) {
        const response = await fetch(new URL(path, this.config.OPENWA_BASE_URL), {
          ...init,
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers,
        });
        if (response.status === 429 && method === 'GET' && operation !== 'get_group'
          && rateLimitRetries < maxRateLimitRetries) {
          response.body?.cancel().catch(() => undefined);
          await delay(rateLimitDelayMs(response.headers, rateLimitRetries));
          rateLimitRetries += 1;
          continue;
        }
        if (response.status >= 500 && method === 'GET' && operation !== 'get_group'
          && transientRetries < maxTransientReadRetries) {
          response.body?.cancel().catch(() => undefined);
          await delay(jitteredBackoffMs(transientRetries, 5_000));
          transientRetries += 1;
          continue;
        }
        if (!response.ok) {
          throw new OpenWAHttpError(
            response.status,
            await response.text(),
            parseRetryAfterMs(response.headers),
          );
        }
        const parsed = schema.safeParse(response.status === 204 ? undefined : await response.json());
        if (!parsed.success) throw new OpenWAResponseValidationError(operation, parsed.error.issues.length);
        this.logger.debug({
          event: 'openwa.request.completed', operation, method, statusCode: response.status,
          durationMs: Math.round((performance.now() - started) * 100) / 100,
          rateLimitRetries,
          transientRetries,
        });
        return parsed.data;
      }
    } catch (error) {
      this.logger.error({
        event: 'openwa.request.failed', operation, method,
        statusCode: error instanceof OpenWAHttpError ? error.status : undefined,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
  }

  listSessions(): Promise<OpenWASession[]> {
    return this.request('list_sessions', '/api/sessions?limit=1000', z.array(sessionSchema).max(1000));
  }

  async assertCompatibleRelease(): Promise<void> {
    const health = await this.request('health', '/api/health', healthSchema);
    if (health.version !== this.config.OPENWA_RELEASE_TAG) {
      throw new Error(
        `OpenWA release mismatch: expected ${this.config.OPENWA_RELEASE_TAG}, received ${health.version}`,
      );
    }
  }

  getSession(sessionId: string): Promise<OpenWASession> {
    return this.request('get_session', `/api/sessions/${encodeURIComponent(sessionId)}`, sessionSchema);
  }

  async listGroups(sessionId: string): Promise<OpenWAGroupSummary[]> {
    const pageSize = 1000;
    const maxPages = 100;
    const groups: OpenWAGroupSummary[] = [];
    const groupIds = new Set<string>();
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const offset = pageNumber * pageSize;
      const page = await this.request('list_groups',
        `/api/sessions/${encodeURIComponent(sessionId)}/groups?limit=${pageSize}&offset=${offset}`,
        z.array(groupSummarySchema).max(pageSize),
      );
      for (const group of page) {
        if (groupIds.has(group.id)) {
          throw new OpenWAResponseValidationError('list_groups', 1);
        }
        groupIds.add(group.id);
      }
      groups.push(...page);
      if (page.length < pageSize) return groups;
    }
    throw new OpenWAResponseValidationError('list_groups', 1);
  }

  getGroup(sessionId: string, groupId: string): Promise<OpenWAGroup> {
    return this.request('get_group',
      `/api/sessions/${encodeURIComponent(sessionId)}/groups/${encodeURIComponent(groupId)}`,
      groupSchema,
    );
  }

  async *listContactPages(sessionId: string): AsyncGenerator<OpenWAContact[]> {
    const pageSize = 1000;
    const maxPages = 100;
    const contactIds = new Set<string>();
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const offset = pageNumber * pageSize;
      const page = await this.request(
        'list_contacts',
        `/api/sessions/${encodeURIComponent(sessionId)}/contacts?limit=${pageSize}&offset=${offset}`,
        z.array(contactSchema).max(pageSize),
      );
      for (const contact of page) {
        if (contactIds.has(contact.id)) throw new OpenWAResponseValidationError('list_contacts', 1);
        contactIds.add(contact.id);
      }
      if (page.length > 0) yield page;
      if (page.length < pageSize) return;
    }
    throw new OpenWAResponseValidationError('list_contacts', 1);
  }

  listWebhooks(sessionId: string): Promise<OpenWAWebhook[]> {
    return this.request(
      'list_webhooks',
      `/api/sessions/${encodeURIComponent(sessionId)}/webhooks`,
      z.array(webhookSchema).max(10_000),
    );
  }

  registerWebhook(input: {
    sessionId: string;
    url: string;
    events: string[];
    secret: string;
    retryCount: number;
  }): Promise<OpenWAWebhook> {
    return this.request('register_webhook', `/api/sessions/${encodeURIComponent(input.sessionId)}/webhooks`, webhookSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: input.url,
        events: input.events,
        secret: input.secret,
        retryCount: input.retryCount,
      }),
    });
  }

  updateWebhook(input: {
    sessionId: string;
    webhookId: string;
    url: string;
    events: string[];
    secret: string;
    active: boolean;
    retryCount: number;
  }): Promise<OpenWAWebhook> {
    return this.request(
      'update_webhook',
      `/api/sessions/${encodeURIComponent(input.sessionId)}/webhooks/${encodeURIComponent(input.webhookId)}`,
      webhookSchema,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: input.url,
          events: input.events,
          secret: input.secret,
          active: input.active,
          retryCount: input.retryCount,
        }),
      },
    );
  }

  deleteWebhook(sessionId: string, webhookId: string): Promise<void> {
    return this.request(
      'delete_webhook',
      `/api/sessions/${encodeURIComponent(sessionId)}/webhooks/${encodeURIComponent(webhookId)}`,
      z.undefined(),
      { method: 'DELETE' },
    );
  }

  async sendText(sessionId: string, chatId: string, text: string): Promise<OpenWASendTextResult> {
    return this.request('send_text', `/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, sendTextResultSchema, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ chatId, text }),
    });
  }
}

function rateLimitDelayMs(headers: Headers, attempt: number): number {
  const exhaustedResets = ['short', 'medium', 'long']
    .filter(tier => headers.get(`x-ratelimit-remaining-${tier}`) === '0')
    .map(tier => Number(headers.get(`x-ratelimit-reset-${tier}`)))
    .filter(value => Number.isFinite(value) && value >= 0);
  if (exhaustedResets.length > 0) {
    return Math.min(60_000, Math.max(250, Math.ceil(Math.max(...exhaustedResets) * 1000)));
  }
  const retryAfterMs = parseRetryAfterMs(headers);
  if (retryAfterMs !== undefined) return retryAfterMs;
  return jitteredBackoffMs(attempt, 60_000);
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60_000, Math.max(250, Math.ceil(seconds * 1000)));
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.min(60_000, Math.max(250, at - Date.now()));
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

const jitteredBackoffMs = (attempt: number, maximum: number): number => {
  const backoff = Math.min(maximum, 250 * 2 ** attempt);
  return Math.ceil(backoff * (0.75 + Math.random() * 0.5));
};
