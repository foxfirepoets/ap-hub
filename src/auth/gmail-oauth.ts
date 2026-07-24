import { config } from '../config.js';
import { saveToken } from './tokens.js';
import { writeAudit } from '../audit.js';
import { logger } from '../logger.js';
import { verifyConnectState } from './connect-state.js';

/**
 * Gmail OAuth callback. Tokens are stored encrypted. Reply drafting uses the
 * compose-only scope; the locked gatekeeper relay remains a separate concern.
 */

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

export function gmailOAuthScopes(draftsEnabled: boolean): string[] {
  return draftsEnabled
    ? [GMAIL_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE]
    : [GMAIL_READONLY_SCOPE];
}

export function hasGmailComposeScope(scope: string | null | undefined): boolean {
  return (scope ?? '').split(/\s+/).includes(GMAIL_COMPOSE_SCOPE);
}

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
  redirect: (location: string) => void,
): Promise<void> {
  const verified = verifyConnectState(url.searchParams.get('state') ?? '');
  if (!verified) {
    respond(400, { error: 'invalid_state' });
    return;
  }
  const { tenantId } = verified;

  const errorParam = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  if (errorParam) {
    redirect(`${config().WEB_BASE_URL}/onboarding?connect_error=gmail&reason=denied`);
    return;
  }
  if (!code) {
    redirect(`${config().WEB_BASE_URL}/onboarding?connect_error=gmail&reason=missing_code`);
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
    redirect(`${config().WEB_BASE_URL}/onboarding?connected=gmail`);
  } catch (err) {
    logger.warn({ err: String(err) }, 'gmail connect failed');
    redirect(`${config().WEB_BASE_URL}/onboarding?connect_error=gmail&reason=exchange_failed`);
  }
}
