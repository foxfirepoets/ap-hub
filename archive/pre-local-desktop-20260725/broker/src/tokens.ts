import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Install-token design (SPEC §9): 32 bytes from `crypto.randomBytes`, base64url,
 * prefixed `aph_`. The broker stores ONLY the SHA-256 — the plaintext is shown once
 * at issue and never persisted. Comparison is constant-time (`timingSafeEqual`).
 */

export const TOKEN_PREFIX = 'aph_';

/** Generate a new install token (plaintext, shown once). */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** SHA-256 hex of a token — the only form persisted. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time compare of two SHA-256 hex digests. Both inputs are fixed-length
 * (64 hex chars) so buffer lengths match; `timingSafeEqual` guards against a
 * byte-by-byte timing leak that would let an attacker probe for a valid token.
 */
export function constantTimeEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'utf8');
  const b = Buffer.from(bHex, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** True when a raw string is shaped like an install token. */
export function looksLikeToken(raw: string): boolean {
  return raw.startsWith(TOKEN_PREFIX) && raw.length > TOKEN_PREFIX.length;
}
