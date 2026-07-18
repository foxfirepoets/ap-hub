import { describe, it, expect, afterAll } from 'vitest';
import { authenticate, extractBearer } from '../src/auth.js';
import { handleRequest } from '../src/server.js';
import { generateToken } from '../src/tokens.js';
import { closePool } from '../src/db.js';
import { seedInstall, captureRespond } from './helpers.js';

/**
 * Auth matrix (SPEC §7): no header → 401 UNAUTHENTICATED, unknown → 401,
 * revoked → 403 TOKEN_REVOKED, valid → 200. Tested at both the `authenticate()`
 * layer (typed result) and the HTTP layer (exact status codes) against the guarded
 * test-only /__authcheck route (BROKER_TEST_AUTH_ROUTE=1 in test setup).
 */

function hdr(token: string): string {
  return `Bearer ${token}`;
}

async function statusFor(authorization: string | undefined, path = '/__authcheck'): Promise<number> {
  const cap = captureRespond();
  await handleRequest('GET', new URL(`http://localhost${path}`), authorization, cap.respond);
  return cap.last().status;
}

describe('bearer auth', () => {
  afterAll(closePool);

  it('extractBearer parses only well-formed headers', () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer('')).toBeNull();
    expect(extractBearer('Basic abc')).toBeNull();
    expect(extractBearer('Bearer aph_abc')).toBe('aph_abc');
    expect(extractBearer('bearer   aph_abc  ')).toBe('aph_abc');
  });

  it('typed results: NO_HEADER / UNKNOWN / REVOKED / OK', async () => {
    const valid = await seedInstall();
    const revoked = await seedInstall({ revoked: true });

    expect(await authenticate(undefined)).toEqual({ ok: false, reason: 'NO_HEADER' });
    // A well-formed but nonexistent token and a garbage token both resolve UNKNOWN.
    expect(await authenticate(hdr(generateToken()))).toEqual({ ok: false, reason: 'UNKNOWN' });
    expect(await authenticate('Bearer not-a-token')).toEqual({ ok: false, reason: 'UNKNOWN' });
    expect(await authenticate(hdr(revoked.token))).toEqual({ ok: false, reason: 'REVOKED' });

    const ok = await authenticate(hdr(valid.token));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.install.label).toBe(valid.label);
  });

  it('HTTP auth matrix → 401 / 401 / 403 / 200', async () => {
    const valid = await seedInstall();
    const revoked = await seedInstall({ revoked: true });

    expect(await statusFor(undefined)).toBe(401); // no header
    expect(await statusFor(hdr(generateToken()))).toBe(401); // unknown token
    expect(await statusFor(hdr(revoked.token))).toBe(403); // revoked
    expect(await statusFor(hdr(valid.token))).toBe(200); // valid
  });

  it('401/403 bodies use the {error:{code,message}} shape', async () => {
    const revoked = await seedInstall({ revoked: true });
    const cap = captureRespond();
    await handleRequest('GET', new URL('http://localhost/__authcheck'), undefined, cap.respond);
    expect(cap.last().body).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });

    const cap2 = captureRespond();
    await handleRequest('GET', new URL('http://localhost/__authcheck'), hdr(revoked.token), cap2.respond);
    expect(cap2.last().body).toMatchObject({ error: { code: 'TOKEN_REVOKED' } });
  });
});
