import { describe, it, expect, afterEach, afterAll, beforeEach, vi } from 'vitest';
import { handleRequest } from '../src/server.js';
import { resetPoolForTest, closePool } from '../src/db.js';
import { setFetchForTest, resetFetchForTest } from '../src/upstream.js';
import { resetRateLimitForTest } from '../src/ratelimit.js';
import { config, resetConfigCache } from '../src/config.js';
import { seedInstall, seedSpend, captureFull } from './helpers.js';

/**
 * CHUNK_3 — the highest-risk chunk. These tests prove the broker's core invariant:
 * it NEVER turns an upstream failure into a success, it makes NO upstream call when
 * it refuses (auth/cap/rate), and it relays a real success VERBATIM.
 */

const GOOD_URL = process.env.DATABASE_URL!;

// Keys must exist for the proxy to attempt an upstream call (else it fails closed
// as a broker misconfig). Set before config is memoized.
process.env.ANTHROPIC_API_KEY ||= 'sk-ant-test-key';
process.env.SWARMSYNC_API_KEY ||= 'ssk_test_key';

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn(impl as any);
  setFetchForTest(spy as unknown as typeof fetch);
  return spy;
}

function jsonResponse(status: number, bodyObj: unknown): Response {
  return new Response(JSON.stringify(bodyObj), { status, headers: { 'content-type': 'application/json' } });
}

async function call(method: string, path: string, token: string, body = '') {
  const cap = captureFull();
  await handleRequest(method, new URL(`http://localhost${path}`), `Bearer ${token}`, cap.respond, body, cap.respondRaw);
  return cap;
}

describe('broker proxy (CHUNK_3) — fail-closed, pass-through, caps', () => {
  beforeEach(() => {
    resetRateLimitForTest();
    resetConfigCache();
    config(); // memoize with test keys present
  });
  afterEach(async () => {
    resetFetchForTest();
    await resetPoolForTest(GOOD_URL);
  });
  afterAll(closePool);

  it('pass-through fidelity: a real upstream 200 is relayed VERBATIM with 200', async () => {
    const upstreamBody = { content: [{ type: 'text', text: '{"vendor_name":"Acme"}' }], usage: { input_tokens: 10, output_tokens: 5 } };
    const spy = mockFetch(() => jsonResponse(200, upstreamBody));
    const { token } = await seedInstall();
    const cap = await call('POST', '/v1/extract', token, JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [] }));
    const last = cap.last();
    expect(last.status).toBe(200);
    expect(last.kind).toBe('raw');
    expect(last.raw).toBe(JSON.stringify(upstreamBody)); // byte-identical
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toBe('https://api.anthropic.com/v1/messages');
  });

  it('upstream NON-2xx is NEVER promoted to 2xx → 502 UPSTREAM_FAILED', async () => {
    mockFetch(() => jsonResponse(500, { error: 'upstream boom' }));
    const { token } = await seedInstall();
    const cap = await call('POST', '/api/verify', token, JSON.stringify({ foo: 1 }));
    expect(cap.last().status).toBe(502);
    expect(cap.last().body).toMatchObject({ error: { code: 'UPSTREAM_FAILED' } });
  });

  it('upstream network throw (DNS/TLS/timeout) fails closed → 502, never 2xx', async () => {
    mockFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const { token } = await seedInstall();
    const cap = await call('POST', '/api/verify', token, JSON.stringify({ foo: 1 }));
    expect(cap.last().status).toBe(502);
    expect(cap.last().body).toMatchObject({ error: { code: 'UPSTREAM_FAILED' } });
  });

  it('a well-formed upstream 200 with an EMPTY body is relayed as-is (broker never fabricates)', async () => {
    // The broker's job is fidelity — it relays the empty 200 verbatim. The ap-hub
    // pipeline (CHUNK_4) is what must treat an empty proof body as a HOLD.
    mockFetch(() => new Response('', { status: 200 }));
    const { token } = await seedInstall();
    const cap = await call('POST', '/api/verify', token, JSON.stringify({ foo: 1 }));
    expect(cap.last().status).toBe(200);
    expect(cap.last().raw).toBe('');
  });

  it('spend cap: at/over cap → 429 SPEND_CAP_EXCEEDED and the upstream is NOT called', async () => {
    const spy = mockFetch(() => jsonResponse(200, { ok: true }));
    const { token, id } = await seedInstall(); // default cap 5.00
    await seedSpend(id, 5.0); // exactly at cap
    const cap = await call('POST', '/v1/extract', token, JSON.stringify({ model: 'x', messages: [] }));
    expect(cap.last().status).toBe(429);
    expect(cap.last().body).toMatchObject({ error: { code: 'SPEND_CAP_EXCEEDED' } });
    expect(cap.last().headers).toHaveProperty('retry-after');
    expect(spy).not.toHaveBeenCalled(); // ← the money-safety assertion
  });

  it('rate limit: the 61st request in the window → 429 RATE_LIMITED, upstream not called', async () => {
    const spy = mockFetch(() => jsonResponse(200, { ok: true }));
    const { token } = await seedInstall();
    const good = JSON.stringify({ model: 'x', messages: [] });
    for (let i = 0; i < 60; i++) await call('POST', '/v1/extract', token, good);
    const before = spy.mock.calls.length;
    const cap = await call('POST', '/v1/extract', token, good);
    expect(cap.last().status).toBe(429);
    expect(cap.last().body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(spy.mock.calls.length).toBe(before); // no extra upstream call
  });

  it('malformed request body → 400 VALIDATION, upstream not called', async () => {
    const spy = mockFetch(() => jsonResponse(200, { ok: true }));
    const { token } = await seedInstall();
    const cap = await call('POST', '/api/verify', token, '{not json');
    expect(cap.last().status).toBe(400);
    expect(cap.last().body).toMatchObject({ error: { code: 'VALIDATION' } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('DB down during the cap check fails CLOSED → 503, upstream not called', async () => {
    const spy = mockFetch(() => jsonResponse(200, { ok: true }));
    const { token } = await seedInstall(); // seed while good
    const DEAD = GOOD_URL.replace(/\/[^/]+$/, '/aphub_broker_nope_missing');
    await resetPoolForTest(DEAD);
    // Auth itself will fail closed here (also a DB read) → 503 either way; the point
    // is: no 2xx, no upstream call.
    const cap = await call('POST', '/v1/extract', token, JSON.stringify({ model: 'x', messages: [] }));
    expect(cap.last().status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });

  it('chain verify GET is proxied and relayed verbatim on success', async () => {
    const spy = mockFetch(() => jsonResponse(200, { verified: true }));
    const { token } = await seedInstall();
    const cap = await call('GET', '/api/proof/abc123/export/verify', token);
    expect(cap.last().status).toBe(200);
    expect(cap.last().raw).toBe(JSON.stringify({ verified: true }));
    expect(spy.mock.calls[0]![0]).toMatch(/\/api\/proof\/abc123\/export\/verify$/);
  });
});
