import { config } from '../config.js';
import { loadToken, saveToken } from '../auth/tokens.js';
import { GmailAuthError, type GmailClient, type GmailMessage } from './client.js';
import { GMAIL_READONLY_SCOPE } from '../auth/gmail-oauth.js';

/**
 * Real googleapis-backed Gmail adapter. Built lazily (heavy SDK) and only used at
 * runtime; unit tests inject a mock GmailClient instead. The forward recipient is
 * bound at construction — this adapter cannot address anyone but the configured
 * QBO capture address (send-lockdown, Phase 0.5).
 */
export async function getGmailClient(tenantId: number): Promise<GmailClient> {
  const cfg = config();
  const tok = await loadToken(tenantId, 'gmail');
  if (!tok) throw new GmailAuthError('Gmail not connected for tenant');

  const { google } = await import('googleapis');
  const oauth2 = new google.auth.OAuth2(
    cfg.GMAIL_CLIENT_ID,
    cfg.GMAIL_CLIENT_SECRET,
    cfg.GMAIL_REDIRECT_URI,
  );
  oauth2.setCredentials({
    access_token: tok.accessToken,
    refresh_token: tok.refreshToken,
    expiry_date: tok.expiresAt ? tok.expiresAt.getTime() : undefined,
  });
  oauth2.on('tokens', (t) => {
    // Persist refreshed access token; keep the existing refresh token if not rotated.
    void saveToken(tenantId, 'gmail', {
      accessToken: t.access_token ?? tok.accessToken,
      refreshToken: t.refresh_token ?? tok.refreshToken,
      expiresAt: t.expiry_date ? new Date(t.expiry_date) : tok.expiresAt,
      scope: tok.scope ?? GMAIL_READONLY_SCOPE,
      realm: null,
    });
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  const forwardTo = cfg.QBO_FORWARDING_ADDRESS;
  const watchedLabel = cfg.WATCHED_LABEL;

  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.code ?? err?.response?.status;
      if (status === 401) throw new GmailAuthError('Gmail token rejected (401)');
      throw err;
    }
  };

  return {
    async listHistory(startHistoryId) {
      return wrap(async () => {
        if (!startHistoryId) {
          // Bootstrap: list recent messages under the watched label.
          const res = await gmail.users.messages.list({
            userId: 'me',
            q: `label:${watchedLabel}`,
            maxResults: 50,
          });
          const ids = (res.data.messages ?? []).map((m) => m.id!).filter(Boolean);
          const headers = [];
          for (const id of ids) headers.push({ id, threadId: '', from: '', subject: '', receivedAt: '' });
          const profile = await gmail.users.getProfile({ userId: 'me' });
          return { messages: headers, newHistoryId: String(profile.data.historyId ?? '') };
        }
        const res = await gmail.users.history.list({
          userId: 'me',
          startHistoryId,
          historyTypes: ['messageAdded'],
        });
        const messages = (res.data.history ?? [])
          .flatMap((h) => h.messagesAdded ?? [])
          .map((m) => m.message?.id)
          .filter((id): id is string => Boolean(id))
          .map((id) => ({ id, threadId: '', from: '', subject: '', receivedAt: '' }));
        return { messages, newHistoryId: String(res.data.historyId ?? startHistoryId) };
      });
    },

    async getMessage(id): Promise<GmailMessage> {
      return wrap(async () => {
        const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        const payload = res.data.payload;
        const headers = payload?.headers ?? [];
        const h = (name: string) =>
          headers.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
        const attachments = [];
        const parts = flattenParts(payload);
        let bodyText = '';
        for (const part of parts) {
          if (part.filename && part.body?.attachmentId) {
            const att = await gmail.users.messages.attachments.get({
              userId: 'me',
              messageId: id,
              id: part.body.attachmentId,
            });
            const data = Buffer.from(att.data.data ?? '', 'base64url');
            attachments.push({ filename: part.filename, mimeType: part.mimeType ?? 'application/octet-stream', data });
          } else if (part.mimeType === 'text/plain' && part.body?.data) {
            bodyText += Buffer.from(part.body.data, 'base64url').toString('utf8');
          }
        }
        return {
          id,
          threadId: res.data.threadId ?? '',
          from: h('From'),
          subject: h('Subject'),
          receivedAt: new Date(Number(res.data.internalDate ?? Date.now())).toISOString(),
          bodyText,
          attachments,
        };
      });
    },

    async sendForward(messageId) {
      return wrap(async () => {
        // Fetch raw and re-send to the FIXED forward address. Recipient is bound here;
        // the caller cannot choose it.
        const raw = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'raw' });
        const original = Buffer.from(raw.data.raw ?? '', 'base64url').toString('utf8');
        const forwarded =
          `To: ${forwardTo}\r\n` +
          `Subject: Fwd (ap-hub)\r\n` +
          `Content-Type: message/rfc822\r\n\r\n` +
          original;
        const res = await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw: Buffer.from(forwarded, 'utf8').toString('base64url') },
        });
        return { sendId: res.data.id ?? '', to: forwardTo };
      });
    },

    async findSentBySubjectTag(tag) {
      return wrap(async () => {
        const res = await gmail.users.messages.list({
          userId: 'me',
          q: `in:sent subject:"${tag}"`,
          maxResults: 1,
        });
        return res.data.messages?.[0]?.id ?? null;
      });
    },
  };
}

function flattenParts(payload: any): any[] {
  if (!payload) return [];
  const out: any[] = [payload];
  for (const p of payload.parts ?? []) out.push(...flattenParts(p));
  return out;
}
