import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { config } from '../src/config.js';
import { signConnectState } from '../src/auth/connect-state.js';
import { handleGmailCallback } from '../src/auth/gmail-oauth.js';
import { handleQboCallback } from '../src/auth/qbo-oauth.js';
import { resetTables, createTenant, countRows, closeAll } from './helpers.js';

/**
 * CHUNK_2_REDIRECT — the plain HTTP server's OAuth callbacks now verify the signed
 * connect-state token FIRST (never trusting a raw `state` query param), then redirect
 * the browser back to /onboarding instead of returning bare JSON. The token-exchange
 * functions (exchangeGmailCode/exchangeQboCode/assertExpectedCompany/saveToken) are
 * exercised unchanged — only the response path around them is under test here.
 */

const { getTokenMock } = vi.hoisted(() => ({ getTokenMock: vi.fn() }));
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        getToken = getTokenMock;
      },
    },
  },
}));

const fetchMock = vi.fn();

describe('CHUNK_2_REDIRECT — handleGmailCallback / handleQboCallback', () => {
  beforeEach(() => {
    getTokenMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    return resetTables();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(closeAll);

  describe('gmail', () => {
    it('valid signed state + valid code → token saved, redirected to connected=gmail (open-redirect attempt ignored)', async () => {
      const t = await createTenant();
      const state = signConnectState(t);
      getTokenMock.mockResolvedValueOnce({
        tokens: { access_token: 'gm-access', refresh_token: 'gm-refresh', expiry_date: Date.now() + 3600_000, scope: 'https://www.googleapis.com/auth/gmail.readonly' },
      });
      const url = new URL(
        `http://localhost/oauth/gmail/callback?code=goodcode&state=${encodeURIComponent(state)}&redirect=https://evil.example.com`,
      );
      const respond = vi.fn();
      const redirect = vi.fn();

      await handleGmailCallback(url, respond, redirect);

      expect(getTokenMock).toHaveBeenCalledWith('goodcode');
      expect(respond).not.toHaveBeenCalled();
      expect(redirect).toHaveBeenCalledWith(`${config().WEB_BASE_URL}/onboarding?connected=gmail`);
      expect(await countRows('oauth_tokens', 'tenant_id=$1 AND provider=$2', [t, 'gmail'])).toBe(1);
      expect(await countRows('audit_log', "tenant_id=$1 AND action='gmail.connect'", [t])).toBe(1);
    });

    it('forged/tampered state → 400 via respond, exchangeGmailCode never called, nothing saved, no redirect', async () => {
      const url = new URL('http://localhost/oauth/gmail/callback?code=goodcode&state=not-a-real-token');
      const respond = vi.fn();
      const redirect = vi.fn();

      await handleGmailCallback(url, respond, redirect);

      expect(getTokenMock).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(400, expect.any(Object));
      expect(await countRows('oauth_tokens')).toBe(0);
    });

    it('expired state → 400 via respond, exchangeGmailCode never called', async () => {
      const t = await createTenant();
      const signedAt = 1_000_000;
      const state = signConnectState(t, () => signedAt);
      const url = new URL(`http://localhost/oauth/gmail/callback?code=goodcode&state=${encodeURIComponent(state)}`);
      const respond = vi.fn();
      const redirect = vi.fn();

      // verifyConnectState defaults to Date.now(), which is far past signedAt (5 min window).
      await handleGmailCallback(url, respond, redirect);

      expect(getTokenMock).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(400, expect.any(Object));
      expect(await countRows('oauth_tokens', 'tenant_id=$1', [t])).toBe(0);
    });

    it('valid state, missing code → redirect to connect_error=gmail&reason=missing_code, no exchange attempted', async () => {
      const t = await createTenant();
      const state = signConnectState(t);
      const url = new URL(`http://localhost/oauth/gmail/callback?state=${encodeURIComponent(state)}`);
      const respond = vi.fn();
      const redirect = vi.fn();

      await handleGmailCallback(url, respond, redirect);

      expect(getTokenMock).not.toHaveBeenCalled();
      expect(redirect).toHaveBeenCalledWith(`${config().WEB_BASE_URL}/onboarding?connect_error=gmail&reason=missing_code`);
      expect(await countRows('oauth_tokens', 'tenant_id=$1', [t])).toBe(0);
    });

    it('valid state, exchange throws → redirect to connect_error=gmail&reason=exchange_failed, nothing saved', async () => {
      const t = await createTenant();
      const state = signConnectState(t);
      getTokenMock.mockRejectedValueOnce(new Error('network down'));
      const url = new URL(`http://localhost/oauth/gmail/callback?code=goodcode&state=${encodeURIComponent(state)}`);
      const respond = vi.fn();
      const redirect = vi.fn();

      await handleGmailCallback(url, respond, redirect);

      expect(redirect).toHaveBeenCalledWith(`${config().WEB_BASE_URL}/onboarding?connect_error=gmail&reason=exchange_failed`);
      expect(await countRows('oauth_tokens', 'tenant_id=$1', [t])).toBe(0);
    });
  });

  describe('qbo', () => {
    function mockQboFetch(companyName: string) {
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('oauth2/v1/tokens/bearer')) {
          return {
            ok: true,
            json: async () => ({ access_token: 'qbo-access', refresh_token: 'qbo-refresh', expires_in: 3600 }),
          } as Response;
        }
        if (u.includes('companyinfo')) {
          return { ok: true, json: async () => ({ CompanyInfo: { CompanyName: companyName } }) } as Response;
        }
        throw new Error(`unexpected fetch: ${u}`);
      });
    }

    it('valid signed state + valid code + matching company → token saved, redirected to connected=qbo', async () => {
      const t = await createTenant();
      const state = signConnectState(t);
      mockQboFetch(config().QBO_SANDBOX_COMPANY_NAME);
      const url = new URL(
        `http://localhost/oauth/qbo/callback?code=goodcode&state=${encodeURIComponent(state)}&realmId=realm-1`,
      );
      const respond = vi.fn();
      const redirect = vi.fn();

      await handleQboCallback(url, respond, redirect);

      expect(fetchMock).toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
      expect(redirect).toHaveBeenCalledWith(`${config().WEB_BASE_URL}/onboarding?connected=qbo`);
      expect(await countRows('oauth_tokens', 'tenant_id=$1 AND provider=$2', [t, 'qbo'])).toBe(1);
    });

    it('wrong-company (confirm-realm mismatch) → no token saved, redirect to connect_error=qbo&reason=wrong_company', async () => {
      const t = await createTenant();
      const state = signConnectState(t);
      mockQboFetch('Some Totally Different Company');
      const url = new URL(
        `http://localhost/oauth/qbo/callback?code=goodcode&state=${encodeURIComponent(state)}&realmId=realm-1`,
      );
      const respond = vi.fn();
      const redirect = vi.fn();

      await handleQboCallback(url, respond, redirect);

      expect(redirect).toHaveBeenCalledWith(`${config().WEB_BASE_URL}/onboarding?connect_error=qbo&reason=wrong_company`);
      expect(await countRows('oauth_tokens', 'tenant_id=$1', [t])).toBe(0);
    });

    it('forged/tampered state → 400 via respond, exchangeQboCode never called (no fetch), nothing saved', async () => {
      const url = new URL('http://localhost/oauth/qbo/callback?code=goodcode&state=garbage&realmId=realm-1');
      const respond = vi.fn();
      const redirect = vi.fn();

      await handleQboCallback(url, respond, redirect);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(400, expect.any(Object));
      expect(await countRows('oauth_tokens')).toBe(0);
    });

    it('valid state, missing code → redirect to connect_error=qbo&reason=missing_code, no exchange attempted', async () => {
      const t = await createTenant();
      const state = signConnectState(t);
      const url = new URL(`http://localhost/oauth/qbo/callback?state=${encodeURIComponent(state)}&realmId=realm-1`);
      const respond = vi.fn();
      const redirect = vi.fn();

      await handleQboCallback(url, respond, redirect);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(redirect).toHaveBeenCalledWith(`${config().WEB_BASE_URL}/onboarding?connect_error=qbo&reason=missing_code`);
      expect(await countRows('oauth_tokens', 'tenant_id=$1', [t])).toBe(0);
    });
  });
});
