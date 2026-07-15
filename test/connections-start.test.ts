import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { config } from '../src/config.js';
import { createSession } from '../src/auth/session.js';
import { verifyConnectState } from '../src/auth/connect-state.js';
import { runGmailConnectStart, runQboConnectStart } from '../src/services/action/index.js';
import { resetTables, createTenant, createUser, closeAll } from './helpers.js';

/**
 * CHUNK_4_STARTROUTES — role-gated GET /api/connections/{gmail,qbo}/start, exercised
 * through the exported `run*` functions the thin `app/api/**` handlers call verbatim.
 * The state token's tenant id must always come from the resolved session, never a
 * client-supplied value — verified below by round-tripping it through verifyConnectState.
 */

async function tokenFor(t: number, role: string, email: string): Promise<string> {
  const uid = await createUser(t, { role, email });
  return (await createSession(uid)).token;
}

function get(token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request('http://localhost/api/connections/gmail/start', { headers });
}

describe('CHUNK_4_STARTROUTES', () => {
  beforeEach(() => resetTables());
  afterAll(closeAll);

  describe('runGmailConnectStart', () => {
    it('401 UNAUTHENTICATED with no session', async () => {
      const res = await runGmailConnectStart(get(null));
      expect(res.status).toBe(401);
      expect(res.headers.get('location')).toBeNull();
    });

    it('403 FORBIDDEN for bookkeeper', async () => {
      const t = await createTenant();
      const token = await tokenFor(t, 'bookkeeper', 'book@example.com');
      const res = await runGmailConnectStart(get(token));
      expect(res.status).toBe(403);
      expect(res.headers.get('location')).toBeNull();
    });

    it('403 FORBIDDEN for cpa', async () => {
      const t = await createTenant();
      const token = await tokenFor(t, 'cpa', 'cpa@example.com');
      const res = await runGmailConnectStart(get(token));
      expect(res.status).toBe(403);
    });

    it('302 to a real Google consent URL for an owner, state resolves to the session tenant id', async () => {
      const t = await createTenant();
      const token = await tokenFor(t, 'owner_controller', 'owner@example.com');
      const res = await runGmailConnectStart(get(token));

      expect(res.status).toBe(302);
      const url = new URL(res.headers.get('location')!);
      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url.searchParams.get('client_id')).toBe(config().GMAIL_CLIENT_ID);
      expect(url.searchParams.get('redirect_uri')).toBe(config().GMAIL_REDIRECT_URI);
      expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly');

      const verified = verifyConnectState(url.searchParams.get('state')!);
      expect(verified?.tenantId).toBe(Number(t));
    });
  });

  describe('runQboConnectStart', () => {
    it('401 UNAUTHENTICATED with no session', async () => {
      const res = await runQboConnectStart(get(null));
      expect(res.status).toBe(401);
    });

    it('403 FORBIDDEN for bookkeeper/cpa', async () => {
      const t = await createTenant();
      const token = await tokenFor(t, 'bookkeeper', 'book2@example.com');
      const res = await runQboConnectStart(get(token));
      expect(res.status).toBe(403);
    });

    it('302 to a real Intuit consent URL for an owner, state resolves to the session tenant id', async () => {
      const t = await createTenant();
      const token = await tokenFor(t, 'owner_controller', 'owner2@example.com');
      const res = await runQboConnectStart(get(token));

      expect(res.status).toBe(302);
      const url = new URL(res.headers.get('location')!);
      expect(url.origin + url.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
      expect(url.searchParams.get('client_id')).toBe(config().QBO_SANDBOX_CLIENT_ID);
      expect(url.searchParams.get('redirect_uri')).toBe(config().QBO_SANDBOX_REDIRECT_URI);
      expect(url.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');

      const verified = verifyConnectState(url.searchParams.get('state')!);
      expect(verified?.tenantId).toBe(Number(t));
    });

    it('a forged tenant id cannot be smuggled in — state is always the session tenant', async () => {
      const t1 = await createTenant();
      const t2 = await createTenant();
      const token = await tokenFor(t1, 'owner_controller', 'owner3@example.com');
      // Even if a caller tried to influence tenant via query/body, the route ignores it —
      // runQboConnectStart never reads anything but the resolved session.
      const req = new Request(`http://localhost/api/connections/qbo/start?tenantId=${t2}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const res = await runQboConnectStart(req);
      const url = new URL(res.headers.get('location')!);
      const verified = verifyConnectState(url.searchParams.get('state')!);
      expect(verified?.tenantId).toBe(Number(t1));
      expect(verified?.tenantId).not.toBe(Number(t2));
    });
  });
});
