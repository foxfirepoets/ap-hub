import { config } from '../config.js';
import { saveToken } from './tokens.js';
import { createQboReadClient } from '../qbo/client.js';
import { writeAudit } from '../audit.js';
import { raiseException } from '../exceptions.js';
import { logger } from '../logger.js';

/**
 * QBO OAuth callback (CHUNK_2). Exchanges the code, then performs a confirm-realm
 * check: reads CompanyInfo and stores the token ONLY if the company name matches
 * QBO_SANDBOX_COMPANY_NAME. A mismatch errors and stores nothing.
 */

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

/** Pure, testable confirm-realm assertion. */
export function assertExpectedCompany(actualName: string, expectedName: string): void {
  const norm = (s: string) => s.trim().toLowerCase();
  if (!expectedName) throw new Error('QBO_SANDBOX_COMPANY_NAME is not configured');
  if (norm(actualName) !== norm(expectedName)) {
    throw new Error(
      `confirm-realm failed: connected company "${actualName}" != expected "${expectedName}"`,
    );
  }
}

export async function exchangeQboCode(
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const cfg = config();
  const basic = Buffer.from(`${cfg.QBO_SANDBOX_CLIENT_ID}:${cfg.QBO_SANDBOX_CLIENT_SECRET}`).toString(
    'base64',
  );
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
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
  if (!res.ok) throw new Error(`QBO token exchange failed: ${res.status}`);
  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
}

export async function handleQboCallback(
  url: URL,
  respond: (status: number, body: unknown) => void,
): Promise<void> {
  const cfg = config();
  const code = url.searchParams.get('code');
  const realmId = url.searchParams.get('realmId') ?? cfg.QBO_SANDBOX_REALM_ID;
  const tenantId = Number(url.searchParams.get('state') ?? '1');
  if (!code) {
    respond(400, { error: 'missing_code' });
    return;
  }
  try {
    const tok = await exchangeQboCode(code, cfg.QBO_SANDBOX_REDIRECT_URI);
    const client = createQboReadClient({
      accessToken: tok.access_token,
      realmId,
      minorVersion: cfg.QBO_MINOR_VERSION,
    });
    const info = await client.getCompanyInfo();
    assertExpectedCompany(info.CompanyName, cfg.QBO_SANDBOX_COMPANY_NAME);

    await saveToken(tenantId, 'qbo', {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: new Date(Date.now() + tok.expires_in * 1000),
      scope: 'com.intuit.quickbooks.accounting',
      realm: realmId,
    });
    await writeAudit({
      tenantId,
      action: 'qbo.connect',
      entity: `realm:${realmId}`,
      realm: realmId,
      detail: { company: info.CompanyName },
    });
    respond(200, { connected: true, company: info.CompanyName, realm: realmId });
  } catch (err) {
    logger.warn({ err: String(err) }, 'qbo connect refused');
    await raiseException({
      tenantId,
      reasonCode: 'auth_failure',
      entityRef: `qbo:${realmId}`,
      detail: (err as Error).message,
    }).catch(() => {});
    respond(400, { connected: false, error: (err as Error).message });
  }
}
