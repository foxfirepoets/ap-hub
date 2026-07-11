import { config } from '../config.js';
import { saveToken } from './tokens.js';
import { writeAudit } from '../audit.js';
import { logger } from '../logger.js';

/**
 * Gmail OAuth callback (CHUNK_2). Completes the flow at `gmail.readonly` scope
 * (the gatekeeper adds `gmail.send` separately). Tokens are stored encrypted.
 */

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

export async function exchangeGmailCode(
  code: string,
): Promise<{ access_token: string; refresh_token: string; expiry_date?: number; scope?: string }> {
  const cfg = config();
  const { google } = await import('googleapis');
  const oauth2 = new google.auth.OAuth2(
    cfg.GMAIL_CLIENT_ID,
    cfg.GMAIL_CLIENT_SECRET,
    cfg.GMAIL_REDIRECT_URI,
  );
  const { tokens } = await oauth2.getToken(code);
  return {
    access_token: tokens.access_token ?? '',
    refresh_token: tokens.refresh_token ?? '',
    expiry_date: tokens.expiry_date ?? undefined,
    scope: tokens.scope ?? undefined,
  };
}

export async function handleGmailCallback(
  url: URL,
  respond: (status: number, body: unknown) => void,
): Promise<void> {
  const code = url.searchParams.get('code');
  const tenantId = Number(url.searchParams.get('state') ?? '1');
  if (!code) {
    respond(400, { error: 'missing_code' });
    return;
  }
  try {
    const tok = await exchangeGmailCode(code);
    await saveToken(tenantId, 'gmail', {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: tok.expiry_date ? new Date(tok.expiry_date) : null,
      scope: tok.scope ?? GMAIL_READONLY_SCOPE,
      realm: null,
    });
    await writeAudit({ tenantId, action: 'gmail.connect', entity: 'gmail' });
    respond(200, { connected: true });
  } catch (err) {
    logger.warn({ err: String(err) }, 'gmail connect failed');
    respond(400, { connected: false, error: (err as Error).message });
  }
}
