import { config } from '../config.js';
import { saveToken } from './tokens.js';
import { loadToken } from './tokens.js';
import { writeAudit } from '../audit.js';
import { logger } from '../logger.js';
import { consumeConnectState } from './connect-state.js';

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

/** Incremental authorization must never silently discard scopes granted earlier. */
export function mergeGmailScopes(
  previous: string | null | undefined,
  granted: string | null | undefined,
): string {
  return [...new Set(`${previous ?? ''} ${granted ?? ''}`.trim().split(/\s+/).filter(Boolean))]
    .sort()
    .join(' ') || GMAIL_READONLY_SCOPE;
}

/**
 * `codeVerifier`/`redirectUri` are additive, optional overrides for the CHUNK_5 desktop
 * loopback flow (S256 PKCE, ephemeral `http://127.0.0.1:{port}/callback`). Omitted, `getToken`
 * is called exactly as before — the plain string form the CHUNK_2 web flow, and its tests,
 * already depend on.
 */
export async function exchangeGmailCode(
  code: string,
  codeVerifier?: string,
  redirectUri?: string,
): Promise<{ access_token: string; refresh_token?: string; expiry_date?: number; scope?: string }> {
  const cfg = config();
  const { google } = await import('googleapis');
  const oauth2 = new google.auth.OAuth2(
    cfg.GMAIL_CLIENT_ID,
    cfg.GMAIL_CLIENT_SECRET,
    cfg.GMAIL_REDIRECT_URI,
  );
  const options: { code: string; codeVerifier?: string; redirect_uri?: string } = { code };
  if (codeVerifier !== undefined) options.codeVerifier = codeVerifier;
  if (redirectUri !== undefined) options.redirect_uri = redirectUri;
  const { tokens } =
    codeVerifier !== undefined || redirectUri !== undefined
      ? await oauth2.getToken(options)
      : await oauth2.getToken(code);
  if (!tokens.access_token) throw new Error('Gmail OAuth: token response missing access_token');
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? undefined,
    expiry_date: tokens.expiry_date ?? undefined,
    scope: tokens.scope ?? undefined,
  };
}

export async function handleGmailCallback(
  url: URL,
  respond: (status: number, body: unknown) => void,
  redirect: (location: string) => void,
  expectedSessionId: number,
): Promise<void> {
  const verified = await consumeConnectState(
    url.searchParams.get('state') ?? '',
    'gmail',
    expectedSessionId,
  );
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
    const previous = await loadToken(tenantId, 'gmail');
    const refreshToken = tok.refresh_token ?? previous?.refreshToken;
    if (!refreshToken) throw new Error('Gmail OAuth: token response missing refresh_token');
    await saveToken(tenantId, 'gmail', {
      accessToken: tok.access_token,
      refreshToken,
      expiresAt: tok.expiry_date ? new Date(tok.expiry_date) : null,
      scope: mergeGmailScopes(previous?.scope, tok.scope),
      realm: null,
    });
    await writeAudit({
      tenantId,
      actor: verified.email ?? `user:${verified.userId}`,
      action: 'gmail.connect',
      entity: 'gmail',
    });
    redirect(`${config().WEB_BASE_URL}/onboarding?connected=gmail`);
  } catch (err) {
    logger.warn({ err: String(err) }, 'gmail connect failed');
    redirect(`${config().WEB_BASE_URL}/onboarding?connect_error=gmail&reason=exchange_failed`);
  }
}
