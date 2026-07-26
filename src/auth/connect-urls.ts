import type { Config } from '../config.js';
import { gmailOAuthScopes } from './gmail-oauth.js';

/**
 * Shared Gmail/QBO OAuth authorize-URL builders (CHUNK_4_STARTROUTES). Single source of
 * truth for the URL shape — used by both the CLI's `connect` command and the new
 * session-gated `app/api/connections/{gmail,qbo}/start` routes. `state` is always the caller's
 * signed CHUNK_1 connect-state token; nothing here trusts unsigned input.
 */

const QBO_SCOPE = 'com.intuit.quickbooks.accounting';

/**
 * Optional overrides for the CHUNK_5 desktop loopback flow, which authorizes against an
 * ephemeral `http://127.0.0.1:{port}/callback` rather than the fixed CHUNK_2 web redirect, and
 * adds the S256 PKCE challenge. Omitted for every existing caller, so the URL shape (and every
 * existing test asserting it) is unchanged.
 */
export interface AuthorizeUrlOverrides {
  redirectUri?: string;
  /** Base64url(SHA-256(code_verifier)) — never the verifier itself. */
  codeChallenge?: string;
}

function pkceQuery(overrides: AuthorizeUrlOverrides): string {
  return overrides.codeChallenge
    ? `&code_challenge=${encodeURIComponent(overrides.codeChallenge)}&code_challenge_method=S256`
    : '';
}

export function buildGmailAuthorizeUrl(cfg: Config, state: string, overrides: AuthorizeUrlOverrides = {}): string {
  const redirectUri = overrides.redirectUri ?? cfg.GMAIL_REDIRECT_URI;
  return (
    `https://accounts.google.com/o/oauth2/v2/auth?client_id=${cfg.GMAIL_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code&access_type=offline&prompt=consent&include_granted_scopes=true` +
    `&scope=${encodeURIComponent(gmailOAuthScopes(cfg.GMAIL_DRAFTS_ENABLED).join(' '))}&state=${encodeURIComponent(state)}` +
    pkceQuery(overrides)
  );
}

export function buildQboAuthorizeUrl(cfg: Config, state: string, overrides: AuthorizeUrlOverrides = {}): string {
  const clientId = cfg.QBO_ENV === 'production' ? cfg.QBO_PRODUCTION_CLIENT_ID : cfg.QBO_SANDBOX_CLIENT_ID;
  const redirectUri = overrides.redirectUri ?? (cfg.QBO_ENV === 'production'
    ? cfg.QBO_PRODUCTION_REDIRECT_URI : cfg.QBO_SANDBOX_REDIRECT_URI);
  return (
    `https://appcenter.intuit.com/connect/oauth2?client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code&scope=${encodeURIComponent(QBO_SCOPE)}&state=${encodeURIComponent(state)}` +
    pkceQuery(overrides)
  );
}
