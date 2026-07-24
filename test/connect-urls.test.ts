import { describe, it, expect } from 'vitest';
import { config } from '../src/config.js';
import { buildGmailAuthorizeUrl, buildQboAuthorizeUrl } from '../src/auth/connect-urls.js';
import { signConnectState, verifyConnectState } from '../src/auth/connect-state.js';

/**
 * CHUNK_4_STARTROUTES — the shared authorize-URL builders used by both the CLI's
 * `connect` command and the new session-gated `app/api/connections/{gmail,qbo}/start` routes.
 */

describe('buildGmailAuthorizeUrl', () => {
  it('contains client_id, redirect_uri, scope, and a state that round-trips to the tenant id', () => {
    const state = signConnectState(42);
    const url = new URL(buildGmailAuthorizeUrl(config(), state));

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(config().GMAIL_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(config().GMAIL_REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly');
    expect(url.searchParams.get('state')).toBe(state);

    const verified = verifyConnectState(url.searchParams.get('state')!);
    expect(verified?.tenantId).toBe(42);
  });

  it('requests compose alongside readonly when drafts are enabled, without broad mailbox scope', () => {
    const cfg = { ...config(), GMAIL_DRAFTS_ENABLED: true };
    const url = new URL(buildGmailAuthorizeUrl(cfg, 'signed-state'));
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ]);
    expect(url.searchParams.get('scope')).not.toMatch(/gmail\.modify|mail\.google\.com/);
  });
});

describe('buildQboAuthorizeUrl', () => {
  it('contains client_id, redirect_uri, scope, and a state that round-trips to the tenant id', () => {
    const state = signConnectState(7);
    const url = new URL(buildQboAuthorizeUrl(config(), state));

    expect(url.origin + url.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
    expect(url.searchParams.get('client_id')).toBe(config().QBO_SANDBOX_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(config().QBO_SANDBOX_REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
    expect(url.searchParams.get('state')).toBe(state);

    const verified = verifyConnectState(url.searchParams.get('state')!);
    expect(verified?.tenantId).toBe(7);
  });
});
