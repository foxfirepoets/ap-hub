import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { config } from '../src/config.js';
import { createConnectState, type ConnectProvider } from '../src/auth/connect-state.js';
import { createSession } from '../src/auth/session.js';
import {
  GMAIL_READONLY_SCOPE,
  handleGmailCallback as handleGmailCallbackBound,
} from '../src/auth/gmail-oauth.js';
import { handleQboCallback as handleQboCallbackBound } from '../src/auth/qbo-oauth.js';
import { resetTables, createTenant, createUser, countRows, closeAll } from './helpers.js';
import { query } from '../src/db/pool.js';
import { findActiveConnectionForTenant } from '../src/mapping/dimensionMappingStore.js';
import { loadToken, saveToken } from '../src/auth/tokens.js';

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
const sessionForState = new Map<string, number>();

async function stateFor(tenantId: number, provider: ConnectProvider, now: () => number = Date.now) {
  const userId = await createUser(tenantId);
  const session = await createSession(userId);
  const state = await createConnectState({ tenantId, userId, sessionId: session.id }, provider, now);
  sessionForState.set(state, Number(session.id));
  return state;
}

function callbackSession(url: URL): number {
  return sessionForState.get(url.searchParams.get('state') ?? '') ?? 0;
}

function handleGmailCallback(
  url: URL,
  respond: (status: number, body: unknown) => void,
  redirect: (location: string) => void,
) {
  return handleGmailCallbackBound(url, respond, redirect, callbackSession(url));
}

function handleQboCallback(
  url: URL,
  respond: (status: number, body: unknown) => void,
  redirect: (location: string) => void,
) {
  return handleQboCallbackBound(url, respond, redirect, callbackSession(url));
}

describe('CHUNK_2_REDIRECT — handleGmailCallback / handleQboCallback', () => {
  beforeEach(() => {
    sessionForState.clear();
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
      const state = await stateFor(t, 'gmail');
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

    it('reconnect without a new refresh token preserves the existing refresh token', async () => {
      const t = await createTenant();
      await saveToken(t, 'gmail', {
        accessToken: 'old-access',
        refreshToken: 'keep-this-refresh',
        expiresAt: null,
        scope: `${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.compose`,
        realm: null,
      });
      const state = await stateFor(t, 'gmail');
      getTokenMock.mockResolvedValueOnce({
        tokens: {
          access_token: 'new-access',
          expiry_date: Date.now() + 3600_000,
          scope: 'https://www.googleapis.com/auth/gmail.readonly',
        },
      });

      await handleGmailCallback(
        new URL(`http://localhost/oauth/gmail/callback?code=reconnect&state=${encodeURIComponent(state)}`),
        vi.fn(),
        vi.fn(),
      );

      await expect(loadToken(t, 'gmail')).resolves.toMatchObject({
        accessToken: 'new-access',
        refreshToken: 'keep-this-refresh',
      });
      expect((await loadToken(t, 'gmail'))?.scope).toContain(
        'https://www.googleapis.com/auth/gmail.compose',
      );
    });

    it('first connection missing refresh token fails without saving partial credentials', async () => {
      const t = await createTenant();
      const state = await stateFor(t, 'gmail');
      getTokenMock.mockResolvedValueOnce({ tokens: { access_token: 'access-only' } });
      const redirect = vi.fn();
      await handleGmailCallback(
        new URL(`http://localhost/oauth/gmail/callback?code=first&state=${encodeURIComponent(state)}`),
        vi.fn(),
        redirect,
      );
      expect(await countRows('oauth_tokens', 'tenant_id=$1', [t])).toBe(0);
      expect(redirect).toHaveBeenCalledWith(
        `${config().WEB_BASE_URL}/onboarding?connect_error=gmail&reason=exchange_failed`,
      );
    });

    it('rejects cross-provider state and replay before token exchange', async () => {
      const t = await createTenant();
      const state = await stateFor(t, 'gmail');
      const qboRespond = vi.fn();
      await handleQboCallback(
        new URL(`http://localhost/oauth/qbo/callback?code=x&realmId=r&state=${encodeURIComponent(state)}`),
        qboRespond,
        vi.fn(),
      );
      expect(qboRespond).toHaveBeenCalledWith(400, expect.any(Object));
      expect(fetchMock).not.toHaveBeenCalled();

      getTokenMock.mockResolvedValueOnce({
        tokens: { access_token: 'a', refresh_token: 'r' },
      });
      await handleGmailCallback(
        new URL(`http://localhost/oauth/gmail/callback?code=x&state=${encodeURIComponent(state)}`),
        vi.fn(),
        vi.fn(),
      );
      expect(getTokenMock).toHaveBeenCalledTimes(1);
      await handleGmailCallback(
        new URL(`http://localhost/oauth/gmail/callback?code=x&state=${encodeURIComponent(state)}`),
        qboRespond,
        vi.fn(),
      );
      expect(getTokenMock).toHaveBeenCalledTimes(1);
    });

    it('binds callback to the exact initiating session without consuming on mismatch', async () => {
      const tenantId = await createTenant();
      const userId = await createUser(tenantId);
      const initiating = await createSession(userId);
      const other = await createSession(userId);
      const state = await createConnectState({
        tenantId,
        userId,
        sessionId: initiating.id,
      }, 'gmail');
      const url = new URL(
        `http://localhost/oauth/gmail/callback?code=good&state=${encodeURIComponent(state)}`,
      );
      const rejected = vi.fn();

      await handleGmailCallbackBound(url, rejected, vi.fn(), Number(other.id));
      expect(rejected).toHaveBeenCalledWith(400, { error: 'invalid_state' });
      expect(getTokenMock).not.toHaveBeenCalled();

      getTokenMock.mockResolvedValueOnce({
        tokens: { access_token: 'a', refresh_token: 'r', scope: GMAIL_READONLY_SCOPE },
      });
      const accepted = vi.fn();
      await handleGmailCallbackBound(url, vi.fn(), accepted, Number(initiating.id));
      expect(getTokenMock).toHaveBeenCalledTimes(1);
      expect(accepted).toHaveBeenCalledWith(
        `${config().WEB_BASE_URL}/onboarding?connected=gmail`,
      );
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
      const state = await stateFor(t, 'gmail', () => signedAt);
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
      const state = await stateFor(t, 'gmail');
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
      const state = await stateFor(t, 'gmail');
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
      const state = await stateFor(t, 'qbo');
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

    it('F5: valid completion → a real `connections` row exists, queryable via findActiveConnectionForTenant', async () => {
      const t = await createTenant();
      const state = await stateFor(t, 'qbo');
      mockQboFetch(config().QBO_SANDBOX_COMPANY_NAME);
      const url = new URL(
        `http://localhost/oauth/qbo/callback?code=goodcode&state=${encodeURIComponent(state)}&realmId=realm-1`,
      );
      const respond = vi.fn();
      const redirect = vi.fn();

      await handleQboCallback(url, respond, redirect);

      expect(await countRows('connections', 'tenant_id=$1 AND provider=$2', [t, 'qbo'])).toBe(1);
      const { rows } = await query<{
        tenant_id: number;
        provider: string;
        external_company: string;
        status: string;
      }>('SELECT tenant_id, provider, external_company, status FROM connections WHERE tenant_id=$1', [t]);
      expect(rows[0]).toMatchObject({
        tenant_id: t,
        provider: 'qbo',
        external_company: 'realm-1',
        status: 'active',
      });

      const active = await findActiveConnectionForTenant(t);
      expect(active).toMatchObject({ provider: 'qbo' });
    });

    it('F5: reconnecting the same company (same realm) is idempotent — no duplicate `connections` row', async () => {
      const t = await createTenant();
      mockQboFetch(config().QBO_SANDBOX_COMPANY_NAME);

      const state1 = await stateFor(t, 'qbo');
      const url1 = new URL(
        `http://localhost/oauth/qbo/callback?code=goodcode&state=${encodeURIComponent(state1)}&realmId=realm-1`,
      );
      await handleQboCallback(url1, vi.fn(), vi.fn());

      const state2 = await stateFor(t, 'qbo');
      const url2 = new URL(
        `http://localhost/oauth/qbo/callback?code=goodcode&state=${encodeURIComponent(state2)}&realmId=realm-1`,
      );
      await handleQboCallback(url2, vi.fn(), vi.fn());

      expect(await countRows('connections', 'tenant_id=$1 AND provider=$2', [t, 'qbo'])).toBe(1);
    });

    it('wrong-company (confirm-realm mismatch) → no token saved, redirect to connect_error=qbo&reason=wrong_company', async () => {
      const t = await createTenant();
      const state = await stateFor(t, 'qbo');
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
      const state = await stateFor(t, 'qbo');
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
