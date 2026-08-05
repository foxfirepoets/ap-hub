import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { refreshXeroToken, getFreshXeroToken } from '../src/auth/xero-refresh.js';
import { saveToken, loadToken } from '../src/auth/tokens.js';
import { resetTables, createTenant, closeAll } from './helpers.js';

/**
 * CHUNK_10 follow-up gap fix — Xero access tokens expire in 30 minutes and, unlike Gmail
 * (auto-refreshed by googleapis), have no refresh mechanism until this. Mirrors
 * qbo-token-refresh.test.ts: the refresh_token grant is POSTed to Xero (public PKCE client
 * — no client_secret/Basic-auth header) and the ROTATED tokens are persisted, and an
 * expired/near-expiry token triggers a refresh while a still-fresh token does not.
 */

function okJson(payload: unknown) {
  return { ok: true, json: async () => payload } as Response;
}

async function seedToken(tenantId: number, expiresAt: Date | null) {
  await saveToken(tenantId, 'xero', {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt,
    scope: 'accounting.contacts accounting.settings',
    realm: 'tenant-guid-1',
  });
}

describe('CHUNK_10 follow-up — refreshXeroToken / getFreshXeroToken', () => {
  beforeEach(() => resetTables());
  afterAll(closeAll);

  it('refreshXeroToken POSTs refresh_token grant (no client_secret) and persists the rotated tokens', async () => {
    const t = await createTenant();
    await seedToken(t, new Date(Date.now() - 60_000)); // already expired

    const fetchMock = vi.fn((_url: string | URL, _init?: RequestInit) =>
      Promise.resolve(
        okJson({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 1800 }),
      ),
    );

    const returned = await refreshXeroToken(t, fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('identity.xero.com/connect/token');
    const reqInit = init as RequestInit | undefined;
    expect((reqInit!.headers as Record<string, string>).authorization).toBeUndefined();
    const body = reqInit!.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh');
    expect(body.get('client_id')).toBeTruthy();

    expect(returned.accessToken).toBe('new-access');
    expect(returned.refreshToken).toBe('rotated-refresh');
    const persisted = await loadToken(t, 'xero');
    expect(persisted!.accessToken).toBe('new-access');
    expect(persisted!.refreshToken).toBe('rotated-refresh');
    expect(persisted!.realm).toBe('tenant-guid-1');
    expect(persisted!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('refreshXeroToken keeps the prior refresh token when Xero does not rotate it', async () => {
    const t = await createTenant();
    await seedToken(t, new Date(Date.now() - 60_000));

    const fetchMock = vi.fn(async () => okJson({ access_token: 'new-access', expires_in: 1800 }));
    const returned = await refreshXeroToken(t, fetchMock as unknown as typeof fetch);

    expect(returned.refreshToken).toBe('old-refresh');
  });

  it('getFreshXeroToken refreshes an expired token', async () => {
    const t = await createTenant();
    await seedToken(t, new Date(Date.now() - 60_000)); // expired

    const fetchMock = vi.fn(async () =>
      okJson({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 1800 }),
    );

    const tok = await getFreshXeroToken(t, fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tok.accessToken).toBe('new-access');
    expect(tok.refreshToken).toBe('rotated-refresh');
  });

  it('getFreshXeroToken does NOT refresh a still-fresh token', async () => {
    const t = await createTenant();
    await seedToken(t, new Date(Date.now() + 1800_000)); // ~30m of life left, above the skew window

    const fetchMock = vi.fn();

    const tok = await getFreshXeroToken(t, fetchMock as unknown as typeof fetch);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tok.accessToken).toBe('old-access');
    expect(tok.refreshToken).toBe('old-refresh');
  });

  it('refreshXeroToken throws when the token response is missing access_token/expires_in', async () => {
    const t = await createTenant();
    await seedToken(t, new Date(Date.now() - 60_000));

    const fetchMock = vi.fn(async () => okJson({ refresh_token: 'rotated-refresh' }));

    await expect(refreshXeroToken(t, fetchMock as unknown as typeof fetch)).rejects.toThrow(
      'xero token refresh: response missing access_token/expires_in',
    );
  });
});
