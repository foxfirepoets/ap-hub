import { config } from '../config.js';
import { loadToken, saveToken, type StoredToken } from './tokens.js';

/**
 * Real QBO access-token refresh (CHUNK_2 gap fix). Gmail access tokens are
 * auto-refreshed by googleapis; QBO's are NOT. A QBO access token lives ~60 min,
 * so without this the first sandbox call after expiry 401s with no recovery. This
 * POSTs the refresh_token grant to Intuit and persists the rotated tokens. Intuit
 * rotates the refresh token on each refresh, so the newest one is written back.
 */

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

// Treat a token as due for refresh once it has under this much life remaining.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

interface IntuitTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export async function refreshQboToken(
  tenantId: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<StoredToken> {
  const existing = await loadToken(tenantId, 'qbo');
  if (!existing) throw new Error('QBO not connected for tenant');

  const cfg = config();
  const clientId = cfg.QBO_ENV === 'production' ? cfg.QBO_PRODUCTION_CLIENT_ID : cfg.QBO_SANDBOX_CLIENT_ID;
  const clientSecret = cfg.QBO_ENV === 'production'
    ? cfg.QBO_PRODUCTION_CLIENT_SECRET : cfg.QBO_SANDBOX_CLIENT_SECRET;
  const basic = Buffer.from(
    `${clientId}:${clientSecret}`,
  ).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: existing.refreshToken,
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  });
  if (!res.ok) throw new Error(`QBO token refresh failed: ${res.status}`);
  const tok = (await res.json()) as IntuitTokenResponse;

  const refreshed: StoredToken = {
    accessToken: tok.access_token,
    // Intuit rotates the refresh token; keep the prior one only if none returned.
    refreshToken: tok.refresh_token ?? existing.refreshToken,
    expiresAt: new Date(Date.now() + tok.expires_in * 1000),
    scope: existing.scope,
    realm: existing.realm,
  };
  await saveToken(tenantId, 'qbo', refreshed);
  return refreshed;
}

/** Load the QBO token, refreshing first if it is expired or near-expiry. */
export async function getFreshQboToken(
  tenantId: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<StoredToken> {
  const tok = await loadToken(tenantId, 'qbo');
  if (!tok) throw new Error('QBO not connected for tenant');
  const dueForRefresh =
    !tok.expiresAt || tok.expiresAt.getTime() - Date.now() <= EXPIRY_SKEW_MS;
  return dueForRefresh ? refreshQboToken(tenantId, fetchImpl) : tok;
}
