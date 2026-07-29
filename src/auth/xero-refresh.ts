import { config } from '../config.js';
import { loadToken, saveToken, type StoredToken } from './tokens.js';

/**
 * Real xero access-token refresh (CHUNK_10 follow-up gap fix). A xero access token lives
 * 30 minutes; without this, the first call after expiry 401s with no recovery — mirrors
 * `qbo-refresh.ts`'s `refreshQboToken`/`getFreshQboToken` exactly, adapted to xero's public
 * PKCE client (no client_secret / Basic-auth header — matches `xero-oauth.ts`'s code exchange).
 * xero also rotates the refresh token on each refresh, so the newest one is written back.
 */

const TOKEN_URL = 'https://identity.xero.com/connect/token';

// Treat a token as due for refresh once it has under this much life remaining.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

interface XeroTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export async function refreshXeroToken(
  tenantId: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<StoredToken> {
  const existing = await loadToken(tenantId, 'xero');
  if (!existing) throw new Error('xero not connected for tenant');

  const cfg = config();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: existing.refreshToken,
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
  if (!res.ok) throw new Error(`xero token refresh failed: ${res.status}`);
  const tok = (await res.json()) as XeroTokenResponse;
  if (!tok.access_token || !Number.isFinite(tok.expires_in)) {
    throw new Error('xero token refresh: response missing access_token/expires_in');
  }

  const refreshed: StoredToken = {
    accessToken: tok.access_token,
    // xero rotates the refresh token; keep the prior one only if none returned.
    refreshToken: tok.refresh_token ?? existing.refreshToken,
    expiresAt: new Date(Date.now() + tok.expires_in * 1000),
    scope: existing.scope,
    realm: existing.realm,
  };
  await saveToken(tenantId, 'xero', refreshed);
  return refreshed;
}

/** Load the xero token, refreshing first if it is expired or near-expiry. */
export async function getFreshXeroToken(
  tenantId: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<StoredToken> {
  const tok = await loadToken(tenantId, 'xero');
  if (!tok) throw new Error('xero not connected for tenant');
  const dueForRefresh =
    !tok.expiresAt || tok.expiresAt.getTime() - Date.now() <= EXPIRY_SKEW_MS;
  return dueForRefresh ? refreshXeroToken(tenantId, fetchImpl) : tok;
}
