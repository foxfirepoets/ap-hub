import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Signed, time-boxed CSRF `state` token for the Gmail/QBO OAuth connect flow
 * (CHUNK_1_STATETOKEN). Stateless — never persisted — so it works across the two
 * separate processes (Next.js "start" route, plain HTTP server callback) that
 * cannot share an HttpOnly cookie.
 *
 * Token shape: base64url(tenantId + '.' + timestamp + '.' + nonce) + '.' + hmacSignature.
 * The HMAC is computed over the base64url payload string itself (the exact bytes
 * carried in the token), keyed by the existing SESSION_COOKIE_SECRET — no new secret.
 */

const MAX_AGE_MS = 5 * 60 * 1000;

function sign(payloadB64: string): string {
  return createHmac('sha256', config().SESSION_COOKIE_SECRET).update(payloadB64).digest('base64url');
}

/** Mint a signed state token for a tenant. `now` is injectable for deterministic tests. */
export function signConnectState(tenantId: number, now: () => number = Date.now): string {
  const nonce = randomBytes(16).toString('base64url');
  const payload = `${tenantId}.${now()}.${nonce}`;
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Verify a state token: recompute the HMAC with a constant-time comparison, then
 * check the embedded timestamp is within 5 minutes of `now()`. Returns `null` on
 * ANY failure (malformed input, bad signature, expired) — never throws.
 */
export function verifyConnectState(
  token: string,
  now: () => number = Date.now,
): { tenantId: number } | null {
  try {
    if (!token) return null;
    const idx = token.lastIndexOf('.');
    if (idx <= 0 || idx === token.length - 1) return null;
    const payloadB64 = token.slice(0, idx);
    const sig = token.slice(idx + 1);

    const expected = sign(payloadB64);
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const parts = payload.split('.');
    if (parts.length !== 3) return null;
    const [tenantIdStr, timestampStr] = parts;
    const tenantId = Number(tenantIdStr);
    const timestamp = Number(timestampStr);
    if (!Number.isInteger(tenantId) || !Number.isFinite(timestamp)) return null;

    if (Math.abs(now() - timestamp) > MAX_AGE_MS) return null;

    return { tenantId };
  } catch {
    return null;
  }
}
