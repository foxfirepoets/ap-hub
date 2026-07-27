import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { config } from '../src/config.js';
import { query } from '../src/db/pool.js';
import { isPortFree } from '../src/db/bootstrap.js';
import {
  closeAllConnectFlows,
  configureConnectFlowHost,
  ConnectFlowNotConfigured,
  hasPendingConnectFlow,
  startConnectFlow,
  type ConnectFlowActor,
} from '../src/auth/connect-loopback.js';
import { configureTokenSecretAuthority, loadToken } from '../src/auth/tokens.js';
import type { SecretStore } from '../src/host/types.js';
import { closeAll, createTenant, createUser, resetTables } from './helpers.js';

/**
 * CHUNK_5_CONNECT — the loopback listener and its state machine, exercised directly (not
 * through the IPC layer, which `test/ipc-contract.test.ts` and `test/ipc-action-domains.test.ts`
 * already cover for role/schema/leakage). This file proves the four properties the spec calls
 * out by name: exact PKCE linkage, single-use state, the listener closing for real, and the
 * plain-language expiry/mismatch classification (`CONNECT_TIMEOUT`).
 */

const { getTokenMock } = vi.hoisted(() => ({ getTokenMock: vi.fn() }));
vi.mock('googleapis', () => ({
  google: { auth: { OAuth2: class { getToken = getTokenMock; } } },
}));

class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async put(target: string, secret: string): Promise<void> {
    this.values.set(target, secret);
  }
  async get(target: string): Promise<string | null> {
    return this.values.get(target) ?? null;
  }
  async delete(target: string): Promise<void> {
    this.values.delete(target);
  }
}

function fakeHost() {
  const openedUrls: string[] = [];
  const focusCalls: number[] = [];
  return {
    openedUrls,
    openExternal: (url: string) => {
      openedUrls.push(url);
    },
    focusWindow: () => {
      focusCalls.push(Date.now());
    },
    focusCalls,
  };
}

function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

async function waitUntil(predicate: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function refusalAudit(tenantId: number): Promise<{ action: string; detail: Record<string, unknown> } | null> {
  const { rows } = await query<{ action: string; detail: Record<string, unknown> }>(
    `SELECT action, detail FROM audit_log WHERE tenant_id=$1 AND action LIKE '%.connect_refused' ORDER BY id DESC LIMIT 1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

/** The LAST write `completeGmail`/`completeQbo` make — the reliable "the whole background
 * exchange finished" signal, unlike `hasPendingConnectFlow`, which flips false as soon as the
 * listener starts closing, before the exchange (or even the close itself) is done. */
async function connectAudit(tenantId: number, provider: 'gmail' | 'qbo'): Promise<boolean> {
  const { rows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id=$1 AND action=$2`,
    [tenantId, `${provider}.connect`],
  );
  return (rows[0]?.n ?? 0) > 0;
}

async function actorFor(tenantId: number): Promise<ConnectFlowActor> {
  const userId = await createUser(tenantId, { email: `owner-${tenantId}@example.com` });
  return { tenantId, userId, sessionId: 1, email: `owner-${tenantId}@example.com` };
}

// Only the QBO token endpoint is mocked. Every other URL — in particular the test's own calls
// to `http://127.0.0.1:{port}/callback` — is a REAL loopback round trip through the real
// global `fetch`, captured before it is stubbed.
const realFetch = globalThis.fetch;
let qboTokenResponder: (() => Promise<unknown> | unknown) | null = null;
const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
  const url = String(args[0]);
  if (url.startsWith('https://oauth.platform.intuit.com')) {
    if (!qboTokenResponder) throw new Error('test setup: no QBO token responder configured');
    return { ok: true, json: async () => qboTokenResponder!() } as Response;
  }
  return realFetch(...args);
});

describe('startConnectFlow', () => {
  let store: MemorySecretStore;

  beforeEach(async () => {
    await resetTables();
    store = new MemorySecretStore();
    configureTokenSecretAuthority({ store, installId: 'install-test' });
    getTokenMock.mockReset();
    fetchMock.mockClear();
    qboTokenResponder = null;
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    // Force-close anything a test started but never drove to completion, so a live listener
    // never leaks into the next test.
    await closeAllConnectFlows();
    configureConnectFlowHost(null);
    configureTokenSecretAuthority(null);
    vi.unstubAllGlobals();
  });

  afterAll(closeAll);

  it('throws ConnectFlowNotConfigured when no host is wired up', async () => {
    configureConnectFlowHost(null);
    const tenantId = await createTenant();
    await expect(startConnectFlow('gmail', await actorFor(tenantId))).rejects.toBeInstanceOf(ConnectFlowNotConfigured);
  });

  it('binds 127.0.0.1 on an ephemeral port and opens an exact-match loopback redirect_uri', async () => {
    const host = fakeHost();
    configureConnectFlowHost(host);
    const tenantId = await createTenant();
    const result = await startConnectFlow('gmail', await actorFor(tenantId));
    expect(result).toBe('browser_opened');
    expect(host.openedUrls).toHaveLength(1);

    const url = new URL(host.openedUrls[0]!);
    expect(url.hostname).toBe('accounts.google.com');
    const redirectUri = new URL(paramsOf(host.openedUrls[0]!).get('redirect_uri')!);
    expect(redirectUri.hostname).toBe('127.0.0.1');
    expect(redirectUri.pathname).toBe('/callback');
    const port = Number(redirectUri.port);
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(80);
    expect(hasPendingConnectFlow('gmail')).toBe(true);
  });

  it('sends the S256 PKCE challenge that matches the verifier used at token-exchange time', async () => {
    const host = fakeHost();
    configureConnectFlowHost(host);
    const tenantId = await createTenant();
    getTokenMock.mockResolvedValueOnce({
      tokens: { access_token: 'gm-access', refresh_token: 'gm-refresh', expiry_date: Date.now() + 3600_000, scope: 'x' },
    });

    await startConnectFlow('gmail', await actorFor(tenantId));
    const consentUrl = host.openedUrls[0]!;
    const state = paramsOf(consentUrl).get('state')!;
    const codeChallenge = paramsOf(consentUrl).get('code_challenge')!;
    expect(paramsOf(consentUrl).get('code_challenge_method')).toBe('S256');
    const redirectUri = paramsOf(consentUrl).get('redirect_uri')!;

    const res = await fetch(`${redirectUri}?state=${encodeURIComponent(state)}&code=goodcode`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('You can close this and return to AP-Hub.');

    await waitUntil(() => getTokenMock.mock.calls.length > 0);
    const usedVerifier = (getTokenMock.mock.calls[0]![0] as { codeVerifier: string }).codeVerifier;
    expect(createHash('sha256').update(usedVerifier).digest('base64url')).toBe(codeChallenge);
    expect((getTokenMock.mock.calls[0]![0] as { redirect_uri: string }).redirect_uri).toBe(redirectUri);
  });

  it('closes the listener after a successful exchange — a new listener can bind the same port', async () => {
    const host = fakeHost();
    configureConnectFlowHost(host);
    const tenantId = await createTenant();
    getTokenMock.mockResolvedValueOnce({
      tokens: { access_token: 'gm-access', refresh_token: 'gm-refresh', expiry_date: Date.now() + 3600_000, scope: 'x' },
    });

    await startConnectFlow('gmail', await actorFor(tenantId));
    const consentUrl = host.openedUrls[0]!;
    const state = paramsOf(consentUrl).get('state')!;
    const redirectUri = new URL(paramsOf(consentUrl).get('redirect_uri')!);
    const port = Number(redirectUri.port);

    await fetch(`${redirectUri.toString()}?state=${encodeURIComponent(state)}&code=goodcode`);
    // Wait for the LAST write the background exchange makes — not for `pending` to clear, which
    // happens the instant the listener STARTS closing, before the close (or the exchange it
    // gates) has actually finished.
    await waitUntil(() => connectAudit(tenantId, 'gmail'));

    // The socket is actually released, not merely believed closed: binding a fresh listener on
    // the exact same port succeeds.
    expect(await isPortFree(port)).toBe(true);
    expect(host.focusCalls).toHaveLength(1);

    const stored = await loadToken(tenantId, 'gmail');
    expect(stored?.accessToken).toBe('gm-access');

    // And a second hit against the (now-closed) port cannot be exchanged again: nothing is
    // listening any more.
    await expect(fetch(`${redirectUri.toString()}?state=${encodeURIComponent(state)}&code=goodcode`)).rejects.toBeTruthy();
    expect(getTokenMock).toHaveBeenCalledTimes(1);
  });

  it('writes a `connections` row for gmail, so aphub:connections:status can show it active', async () => {
    const host = fakeHost();
    configureConnectFlowHost(host);
    const tenantId = await createTenant();
    getTokenMock.mockResolvedValueOnce({
      tokens: { access_token: 'gm-access', refresh_token: 'gm-refresh', expiry_date: Date.now() + 3600_000, scope: 'x' },
    });
    const actor = await actorFor(tenantId);

    await startConnectFlow('gmail', actor);
    const consentUrl = host.openedUrls[0]!;
    const state = paramsOf(consentUrl).get('state')!;
    const redirectUri = paramsOf(consentUrl).get('redirect_uri')!;
    await fetch(`${redirectUri}?state=${encodeURIComponent(state)}&code=goodcode`);
    await waitUntil(() => connectAudit(tenantId, 'gmail'));

    const { rows } = await query<{ provider: string; status: string; external_company: string }>(
      `SELECT provider, status, external_company FROM connections WHERE tenant_id=$1 AND provider='gmail'`,
      [tenantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('active');
    expect(rows[0]!.external_company).toBe(actor.email);

    const { rows: audit } = await query<{ action: string }>(
      `SELECT action FROM audit_log WHERE tenant_id=$1 AND action='gmail.connect'`,
      [tenantId],
    );
    expect(audit).toHaveLength(1);
  });

  it('completes a real QBO round trip: token stored, connection upserted, listener closed', async () => {
    const host = fakeHost();
    configureConnectFlowHost(host);
    const tenantId = await createTenant();
    qboTokenResponder = () => ({ access_token: 'qb-access', refresh_token: 'qb-refresh', expires_in: 3600 });
    const actor = await actorFor(tenantId);

    await startConnectFlow('qbo', actor);
    const consentUrl = host.openedUrls[0]!;
    expect(new URL(consentUrl).hostname).toBe('appcenter.intuit.com');
    const state = paramsOf(consentUrl).get('state')!;
    const redirectUri = paramsOf(consentUrl).get('redirect_uri')!;

    await fetch(`${redirectUri}?state=${encodeURIComponent(state)}&code=goodcode&realmId=REALM-9`);
    await waitUntil(() => connectAudit(tenantId, 'qbo'));

    const stored = await loadToken(tenantId, 'qbo');
    expect(stored?.accessToken).toBe('qb-access');
    expect(stored?.realm).toBe('REALM-9');

    const { rows } = await query<{ status: string }>(
      `SELECT status FROM connections WHERE tenant_id=$1 AND provider='qbo' AND external_company='REALM-9'`,
      [tenantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('active');

    const port = Number(new URL(redirectUri).port);
    expect(await isPortFree(port)).toBe(true);
  });

  it('refuses a mismatched state, audits it as CONNECT_TIMEOUT, never exchanges the code, and closes the listener', async () => {
    const host = fakeHost();
    configureConnectFlowHost(host);
    const tenantId = await createTenant();
    const actor = await actorFor(tenantId);

    await startConnectFlow('gmail', actor);
    const consentUrl = host.openedUrls[0]!;
    const redirectUri = new URL(paramsOf(consentUrl).get('redirect_uri')!);
    const port = Number(redirectUri.port);

    const res = await fetch(`${redirectUri.toString()}?state=wrong-state&code=stolencode`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('You can close this and return to AP-Hub.');

    await waitUntil(async () => (await refusalAudit(tenantId)) !== null);
    const audit = await refusalAudit(tenantId);
    expect(audit?.action).toBe('gmail.connect_refused');
    expect(audit?.detail).toMatchObject({ code: 'CONNECT_TIMEOUT', reason: 'state_mismatch' });
    expect(getTokenMock).not.toHaveBeenCalled();
    await waitUntil(async () => isPortFree(port));
  });

  it('a provider-denied consent is refused, never exchanged, and closes the listener without a raw error page', async () => {
    const host = fakeHost();
    configureConnectFlowHost(host);
    const tenantId = await createTenant();
    const actor = await actorFor(tenantId);

    await startConnectFlow('gmail', actor);
    const consentUrl = host.openedUrls[0]!;
    const state = paramsOf(consentUrl).get('state')!;
    const redirectUri = new URL(paramsOf(consentUrl).get('redirect_uri')!);
    const port = Number(redirectUri.port);

    const res = await fetch(`${redirectUri.toString()}?state=${encodeURIComponent(state)}&error=access_denied`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('You can close this and return to AP-Hub.');
    expect(body).not.toMatch(/access_denied|stack|Error:/i);

    await waitUntil(async () => (await refusalAudit(tenantId)) !== null);
    expect((await refusalAudit(tenantId))?.detail).toMatchObject({ reason: 'denied' });
    expect(getTokenMock).not.toHaveBeenCalled();
    await waitUntil(async () => isPortFree(port));
  });

  it('expires after the configured timeout, audits it as CONNECT_TIMEOUT, and frees the port', async () => {
    const host = fakeHost();
    configureConnectFlowHost(host);
    const tenantId = await createTenant();
    const actor = await actorFor(tenantId);

    await startConnectFlow('gmail', actor, { timeoutMs: 30 });
    const consentUrl = host.openedUrls[0]!;
    const port = Number(new URL(paramsOf(consentUrl).get('redirect_uri')!).port);

    await waitUntil(async () => (await refusalAudit(tenantId)) !== null);
    const audit = await refusalAudit(tenantId);
    expect(audit?.action).toBe('gmail.connect_refused');
    expect(audit?.detail).toMatchObject({ code: 'CONNECT_TIMEOUT', reason: 'expired' });
    await waitUntil(async () => isPortFree(port));
  });

  it('starting a second attempt for the same provider supersedes the first, whose port frees up', async () => {
    const host = fakeHost();
    configureConnectFlowHost(host);
    const tenantId = await createTenant();
    const actor = await actorFor(tenantId);

    await startConnectFlow('gmail', actor);
    const firstPort = Number(new URL(paramsOf(host.openedUrls[0]!).get('redirect_uri')!).port);

    await startConnectFlow('gmail', actor);
    expect(host.openedUrls).toHaveLength(2);

    await waitUntil(async () => isPortFree(firstPort));
    // the second attempt is still live and its own port is not free.
    const secondPort = Number(new URL(paramsOf(host.openedUrls[1]!).get('redirect_uri')!).port);
    expect(await isPortFree(secondPort)).toBe(false);
  });
});

// Config sanity: PKCE query params never touch the pre-existing web-flow authorize URLs unless
// explicitly asked for, so CHUNK_2's own callers and tests are unaffected.
describe('authorize URL builders stay backward compatible with no overrides', () => {
  it('buildGmailAuthorizeUrl omits code_challenge when no override is given', async () => {
    const { buildGmailAuthorizeUrl } = await import('../src/auth/connect-urls.js');
    const url = buildGmailAuthorizeUrl(config(), 'state-x');
    expect(url).not.toContain('code_challenge');
  });
});
