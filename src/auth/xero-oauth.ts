import { config } from '../config.js';

/**
 * xero OAuth code exchange (CHUNK_10 Task 2). PKCE against a "Desktop app"-type xero OAuth
 * client — no client_secret is ever sent (mirrors `qbo-oauth.ts`'s `exchangeQboCode`, minus the
 * Basic-auth header QBO's confidential client requires).
 *
 * New granular OAuth scopes only (mandatory for any xero app created after 2026-03-02) — never
 * the old broad `accounting.transactions` scope.
 */

export const XERO_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'accounting.contacts',
  'accounting.settings',
  'accounting.attachments',
  'accounting.invoices',
  'accounting.reports.read',
] as const;

export function xeroOAuthScopes(): string[] {
  return [...XERO_SCOPES];
}

const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';

export interface ExchangedXeroToken {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  /** The single authorized xero organisation's identifier, resolved via GET /connections
   *  (xero's OAuth grant can cover multiple orgs; this per-customer-app architecture expects
   *  exactly one — zero or more than one is treated as a connect failure, never guessed). */
  tenantId: string;
}

/**
 * Exchanges an authorization code for tokens, then resolves the authorized tenant via xero's
 * `/connections` endpoint. `codeVerifier`/`redirectUri` are required — unlike Gmail/QBO, xero
 * has no pre-CHUNK_5 web flow this also has to serve, so there is no plain-string calling shape
 * to stay backward compatible with.
 */
export async function exchangeXeroCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ExchangedXeroToken> {
  const cfg = config();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: cfg.XERO_CLIENT_ID,
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  });
  if (!res.ok) throw new Error(`xero token exchange failed: ${res.status}`);
  const tok = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!tok.access_token || !tok.refresh_token || !Number.isFinite(tok.expires_in)) {
    throw new Error('xero OAuth: token response missing access_token/refresh_token/expires_in');
  }

  const connRes = await fetchImpl(CONNECTIONS_URL, {
    headers: {
      authorization: `Bearer ${tok.access_token}`,
      accept: 'application/json',
    },
  });
  if (!connRes.ok) throw new Error(`xero connections lookup failed: ${connRes.status}`);
  const connections = (await connRes.json()) as unknown;
  if (!Array.isArray(connections) || connections.length !== 1) {
    const found = Array.isArray(connections) ? connections.length : 'a malformed response';
    throw new Error(
      `xero connect failed: expected exactly one authorized organisation, found ${found}`,
    );
  }
  const tenantId = (connections[0] as { tenantId?: unknown } | null)?.tenantId;
  if (typeof tenantId !== 'string' || !tenantId) {
    throw new Error('xero connect failed: /connections response is missing a tenantId');
  }

  return {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_in: tok.expires_in as number,
    scope: tok.scope,
    tenantId,
  };
}
