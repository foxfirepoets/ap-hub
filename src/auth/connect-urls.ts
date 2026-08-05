import type { Config } from '../config.js';
import { gmailOAuthScopes } from './gmail-oauth.js';
import { xeroOAuthScopes } from './xero-oauth.js';

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

/**
 * Whether the given provider actually has OAuth credentials configured. Neither
 * `buildGmailAuthorizeUrl` nor `buildQboAuthorizeUrl` checks this themselves — both happily
 * build a URL with a blank `client_id`, which Google/Intuit then reject with their own raw
 * "Error 400: invalid_request" page. Callers (`src/services/action/connections.ts`) check this
 * BEFORE opening that URL, so a not-yet-configured provider gets BookScout OS's own plain-language
 * message instead of the far side's technical error screen.
 */
export function isProviderConfigured(cfg: Config, provider: 'gmail' | 'qbo' | 'xero'): boolean {
  if (provider === 'gmail') {
    return cfg.GMAIL_CLIENT_ID.trim() !== '' && cfg.GMAIL_CLIENT_SECRET.trim() !== '';
  }
  if (provider === 'xero') {
    // PKCE Desktop-app client: no client_secret to check, unlike gmail/qbo.
    return cfg.XERO_CLIENT_ID.trim() !== '';
  }
  const clientId = cfg.QBO_ENV === 'production' ? cfg.QBO_PRODUCTION_CLIENT_ID : cfg.QBO_SANDBOX_CLIENT_ID;
  const clientSecret =
    cfg.QBO_ENV === 'production' ? cfg.QBO_PRODUCTION_CLIENT_SECRET : cfg.QBO_SANDBOX_CLIENT_SECRET;
  return clientId.trim() !== '' && clientSecret.trim() !== '';
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

/**
 * PKCE against a "Desktop app"-type xero OAuth client — always via the CHUNK_5 loopback flow, so
 * `overrides.redirectUri` is always supplied by the caller (there is no fixed web-flow redirect
 * for xero the way GMAIL_REDIRECT_URI/QBO_*_REDIRECT_URI have; falling back to '' here would only
 * matter if this were ever called without it, which no caller does).
 */
export function buildXeroAuthorizeUrl(cfg: Config, state: string, overrides: AuthorizeUrlOverrides = {}): string {
  const redirectUri = overrides.redirectUri ?? '';
  return (
    `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${cfg.XERO_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(xeroOAuthScopes().join(' '))}&state=${encodeURIComponent(state)}` +
    pkceQuery(overrides)
  );
}
