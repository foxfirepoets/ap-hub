import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { refreshQboToken, getFreshQboToken } from '../src/auth/qbo-refresh.js';
import { saveToken, loadToken } from '../src/auth/tokens.js';
import { resetTables, createTenant, closeAll } from './helpers.js';

/**
 * FIX-F6 — QBO does NOT auto-refresh (Gmail does, via googleapis). These tests prove
 * the new refresh helper: the refresh_token grant is POSTed to Intuit and the ROTATED
 * tokens are persisted, and an expired/near-expiry token triggers a refresh while a
 * still-fresh token does not.
 */

function okJson(payload: unknown) {
  return { ok: true, json: async () => payload } as Response;
}

async function seedToken(tenantId: number, expiresAt: Date | null) {
  await saveToken(tenantId, 'qbo', {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt,
    scope: 'com.intuit.quickbooks.accounting',
    realm: 'realm-1',
  });
}

describe('FIX-F6 — refreshQboToken / getFreshQboToken', () => {
  beforeEach(() => resetTables());
  afterAll(closeAll);

  it('refreshQboToken POSTs refresh_token grant and persists the rotated tokens', async () => {
    const t = await createTenant();
    await seedToken(t, new Date(Date.now() - 60_000)); // already expired

    const fetchMock = vi.fn((_url: string | URL, _init?: RequestInit) =>
      Promise.resolve(
        okJson({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600 }),
      ),
    );

    const returned = await refreshQboToken(t, fetchMock as unknown as typeof fetch);

    // Called the Intuit token endpoint with a refresh_token grant carrying the OLD refresh token.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
    const body = (init as RequestInit | undefined)!.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh');

    // Returned + persisted rows carry the ROTATED tokens (old ones are gone).
    expect(returned.accessToken).toBe('new-access');
    expect(returned.refreshToken).toBe('rotated-refresh');
    const persisted = await loadToken(t, 'qbo');
    expect(persisted!.accessToken).toBe('new-access');
    expect(persisted!.refreshToken).toBe('rotated-refresh');
    expect(persisted!.realm).toBe('realm-1');
    expect(persisted!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('getFreshQboToken refreshes an expired token', async () => {
    const t = await createTenant();
    await seedToken(t, new Date(Date.now() - 60_000)); // expired

    const fetchMock = vi.fn(async () =>
      okJson({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600 }),
    );

    const tok = await getFreshQboToken(t, fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tok.accessToken).toBe('new-access');
    expect(tok.refreshToken).toBe('rotated-refresh');
  });

  it('getFreshQboToken does NOT refresh a still-fresh token', async () => {
    const t = await createTenant();
    await seedToken(t, new Date(Date.now() + 3600_000)); // ~1h of life left

    const fetchMock = vi.fn();

    const tok = await getFreshQboToken(t, fetchMock as unknown as typeof fetch);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tok.accessToken).toBe('old-access');
    expect(tok.refreshToken).toBe('old-refresh');
  });
});
