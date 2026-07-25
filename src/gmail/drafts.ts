import { config } from '../config.js';
import { loadToken, saveToken } from '../auth/tokens.js';
import { GMAIL_COMPOSE_SCOPE, hasGmailComposeScope } from '../auth/gmail-oauth.js';
import { GmailAuthError } from './client.js';

export type GmailDraftStatus = 'created' | 'discarded' | 'sent_external';

export interface SourceConversation {
  messageId: string;
  threadId: string;
  from: string;
  replyTo?: string;
  subject: string;
}

export interface DraftCopy {
  subject: string;
  bodyText: string;
}

export interface GmailDraftProjection {
  providerDraftId: string;
  providerMessageId: string | null;
  threadId: string;
  to: string;
  status: GmailDraftStatus;
}

/**
 * Compose-only boundary for source-thread drafts. It intentionally has no
 * operation that transmits mail; humans send from Gmail itself.
 */
export interface GmailDraftClient {
  createInSourceThread(source: SourceConversation, copy: DraftCopy): Promise<GmailDraftProjection>;
  reconcileCreateInSourceThread(
    source: SourceConversation,
    copy: DraftCopy,
  ): Promise<GmailDraftProjection | null>;
  updateInSourceThread(
    providerDraftId: string,
    source: SourceConversation,
    copy: DraftCopy,
  ): Promise<GmailDraftProjection>;
  readStatus(providerDraftId: string, sourceThreadId: string): Promise<GmailDraftProjection>;
  discard(providerDraftId: string, sourceThreadId: string): Promise<void>;
}

export class GmailComposeScopeError extends Error {
  readonly code = 'GMAIL_COMPOSE_SCOPE_REQUIRED';
  constructor() {
    super('Reconnect Gmail with compose access to create or update reply drafts.');
    this.name = 'GmailComposeScopeError';
  }
}

export class GmailDraftRetryError extends Error {
  readonly code = 'DRAFT_RETRY';
  constructor(message: string) {
    super(message);
    this.name = 'GmailDraftRetryError';
  }
}

/** The provider may have committed a create whose response was lost. Never retry blindly. */
export class GmailDraftResultUnknownError extends Error {
  readonly code = 'DRAFT_RESULT_UNKNOWN';
  constructor(message: string) {
    super(message);
    this.name = 'GmailDraftResultUnknownError';
  }
}

type DraftResource = {
  id?: string | null;
  message?: { id?: string | null; threadId?: string | null } | null;
};

export interface GmailDraftTransport {
  create(raw: string, threadId: string): Promise<DraftResource>;
  findByMarker(marker: string): Promise<DraftResource | null>;
  update(id: string, raw: string, threadId: string): Promise<DraftResource>;
  get(id: string): Promise<DraftResource>;
  discard(id: string): Promise<void>;
}

export function createGmailDraftClient(
  transport: GmailDraftTransport,
  grantedScope: string | null | undefined,
): GmailDraftClient {
  const requireCompose = () => {
    if (!hasGmailComposeScope(grantedScope)) throw new GmailComposeScopeError();
  };

  return {
    async createInSourceThread(source, copy) {
      requireCompose();
      const to = deriveReplyRecipient(source);
      const marker = draftMarker(source);
      let draft: DraftResource;
      try {
        // Create is intentionally single-shot. A timeout/5xx can mean Gmail committed it.
        draft = await transport.create(
          buildReplyRaw(to, source.subject, copy.bodyText, marker),
          source.threadId,
        );
      } catch (error: any) {
        const status = errorStatus(error);
        if (status === 401 || status === 403) {
          throw new GmailAuthError(`Gmail token or scope rejected (${status})`);
        }
        if (isAmbiguousProviderFailure(status)) {
          throw new GmailDraftResultUnknownError(
            `Gmail draft create result is unknown: ${String(error)}`,
          );
        }
        throw error;
      }
      return projectDraft(draft, source.threadId, to, 'created');
    },
    async reconcileCreateInSourceThread(source, _copy) {
      requireCompose();
      const found = await retryDraftOperation(() => transport.findByMarker(draftMarker(source)));
      return found
        ? projectDraft(found, source.threadId, deriveReplyRecipient(source), 'created')
        : null;
    },
    async updateInSourceThread(providerDraftId, source, copy) {
      requireCompose();
      const to = deriveReplyRecipient(source);
      let draft: DraftResource;
      try {
        // Like create, update is a remote mutation: a lost response may follow a commit.
        // The service persists result_unknown and requires read-back before another update.
        draft = await transport.update(
          providerDraftId,
          buildReplyRaw(to, source.subject, copy.bodyText, draftMarker(source)),
          source.threadId,
        );
      } catch (error: any) {
        const status = errorStatus(error);
        if (status === 401 || status === 403) {
          throw new GmailAuthError(`Gmail token or scope rejected (${status})`);
        }
        if (isAmbiguousProviderFailure(status)) {
          throw new GmailDraftResultUnknownError(
            `Gmail draft update result is unknown: ${String(error)}`,
          );
        }
        throw error;
      }
      return projectDraft(draft, source.threadId, to, 'created', providerDraftId);
    },
    async readStatus(providerDraftId, sourceThreadId) {
      requireCompose();
      const draft = await retryDraftOperation(() => transport.get(providerDraftId));
      const actualThread = draft.message?.threadId ?? '';
      if (actualThread !== sourceThreadId) throw new Error('Gmail draft is not in the source thread');
      return projectDraft(draft, sourceThreadId, '', 'created', providerDraftId);
    },
    async discard(providerDraftId, sourceThreadId) {
      requireCompose();
      const existing = await retryDraftOperation(() => transport.get(providerDraftId));
      if (existing.message?.threadId !== sourceThreadId) {
        throw new Error('Gmail draft is not in the source thread');
      }
      await retryDraftOperation(() => transport.discard(providerDraftId));
    },
  };
}

export async function getGmailDraftClient(tenantId: number): Promise<GmailDraftClient> {
  const cfg = config();
  if (!cfg.GMAIL_DRAFTS_ENABLED) throw new GmailComposeScopeError();
  const tok = await loadToken(tenantId, 'gmail');
  if (!tok) throw new GmailAuthError('Gmail not connected for tenant');
  if (!hasGmailComposeScope(tok.scope)) throw new GmailComposeScopeError();

  const { google } = await import('googleapis');
  const oauth2 = new google.auth.OAuth2(cfg.GMAIL_CLIENT_ID, cfg.GMAIL_CLIENT_SECRET, cfg.GMAIL_REDIRECT_URI);
  oauth2.setCredentials({
    access_token: tok.accessToken,
    refresh_token: tok.refreshToken,
    expiry_date: tok.expiresAt?.getTime(),
  });
  oauth2.on('tokens', (next) => {
    void saveToken(tenantId, 'gmail', {
      accessToken: next.access_token ?? tok.accessToken,
      refreshToken: next.refresh_token ?? tok.refreshToken,
      expiresAt: next.expiry_date ? new Date(next.expiry_date) : tok.expiresAt,
      scope: tok.scope ?? GMAIL_COMPOSE_SCOPE,
      realm: null,
    });
  });
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  return createGmailDraftClient(
    {
      async create(raw, threadId) {
        const { data } = await gmail.users.drafts.create({
          userId: 'me',
          requestBody: { message: { raw, threadId } },
        });
        return data;
      },
      async findByMarker(marker) {
        const listed = await gmail.users.drafts.list({
          userId: 'me',
          q: `rfc822msgid:${marker}`,
          maxResults: 2,
        });
        const id = listed.data.drafts?.[0]?.id;
        if (!id) return null;
        const { data } = await gmail.users.drafts.get({ userId: 'me', id, format: 'minimal' });
        return data;
      },
      async update(id, raw, threadId) {
        const { data } = await gmail.users.drafts.update({
          userId: 'me',
          id,
          requestBody: { message: { raw, threadId } },
        });
        return data;
      },
      async get(id) {
        const { data } = await gmail.users.drafts.get({ userId: 'me', id, format: 'minimal' });
        return data;
      },
      async discard(id) {
        await gmail.users.drafts.delete({ userId: 'me', id });
      },
    },
    tok.scope,
  );
}

export function deriveReplyRecipient(source: SourceConversation): string {
  const candidate = source.replyTo?.trim() || source.from.trim();
  const bracketed = candidate.match(/<([^<>]+)>/)?.[1] ?? candidate;
  const address = bracketed.trim();
  if (/[\r\n]/.test(address) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new Error('Source conversation has no safe reply recipient');
  }
  return address;
}

function buildReplyRaw(to: string, subject: string, bodyText: string, marker?: string): string {
  if (/[\r\n]/.test(subject)) throw new Error('Unsafe source subject');
  const replySubject = /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
  const mime =
    `To: ${to}\r\n` +
    `Subject: ${replySubject}\r\n` +
    (marker ? `Message-ID: <${marker}>\r\nX-AP-Hub-Draft-Key: ${marker}\r\n` : '') +
    'Content-Type: text/plain; charset="UTF-8"\r\n' +
    'MIME-Version: 1.0\r\n\r\n' +
    bodyText;
  return Buffer.from(mime, 'utf8').toString('base64url');
}

function draftMarker(source: SourceConversation): string {
  const safe = Buffer.from(`${source.threadId}\0${source.messageId}`, 'utf8')
    .toString('base64url')
    .slice(0, 96);
  return `ap-hub-${safe}@draft.local`;
}

function errorStatus(error: any): number {
  return Number(error?.code ?? error?.response?.status ?? 0);
}

function isAmbiguousProviderFailure(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function projectDraft(
  draft: DraftResource,
  expectedThreadId: string,
  to: string,
  status: GmailDraftStatus,
  fallbackId = '',
): GmailDraftProjection {
  const threadId = draft.message?.threadId ?? '';
  if (!threadId || threadId !== expectedThreadId) throw new Error('Gmail draft is not in the source thread');
  const providerDraftId = draft.id ?? fallbackId;
  if (!providerDraftId) throw new Error('Gmail did not return a draft id');
  return {
    providerDraftId,
    providerMessageId: draft.message?.id ?? null,
    threadId,
    to,
    status,
  };
}

async function retryDraftOperation<T>(operation: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error: any) {
      const status = errorStatus(error);
      if (status === 401 || status === 403) {
        throw new GmailAuthError(`Gmail token or scope rejected (${status})`);
      }
      last = error;
      if (status !== 429 && status < 500) throw error;
    }
  }
  throw new GmailDraftRetryError(`Gmail draft operation failed after retry: ${String(last)}`);
}
