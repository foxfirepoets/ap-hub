import { query } from './db.js';
import { hashToken, constantTimeEqual, looksLikeToken } from './tokens.js';

/**
 * Bearer-token auth for the broker (SPEC §7, §9). Every route except `/health`
 * runs this FIRST. Results are typed so the server maps them to exact statuses:
 *   NO_HEADER / UNKNOWN → 401 UNAUTHENTICATED
 *   REVOKED             → 403 TOKEN_REVOKED
 *   OK                  → the install row
 *
 * Unknown vs known-bad tokens both return 401 and reveal nothing about existence.
 * The stored hash is compared to the computed hash in constant time.
 */

export interface Install {
  id: string;
  label: string;
  token_sha256: string;
  revoked_at: string | null;
  weekly_cap_usd: string;
  created_at: string;
  last_seen_at: string | null;
}

export type AuthResult =
  | { ok: true; install: Install }
  | { ok: false; reason: 'NO_HEADER' | 'UNKNOWN' | 'REVOKED' };

const BEARER_RE = /^Bearer\s+(.+)$/i;

/** Extract the raw token from an Authorization header value, or null. */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = BEARER_RE.exec(header.trim());
  if (!m || !m[1]) return null;
  return m[1].trim();
}

export async function authenticate(authorization: string | undefined): Promise<AuthResult> {
  const raw = extractBearer(authorization);
  if (!raw || !looksLikeToken(raw)) return { ok: false, reason: raw ? 'UNKNOWN' : 'NO_HEADER' };

  const digest = hashToken(raw);
  const { rows } = await query<Install>(
    'SELECT id, label, token_sha256, revoked_at, weekly_cap_usd, created_at, last_seen_at FROM installs WHERE token_sha256 = $1',
    [digest],
  );
  const install = rows[0];
  // Constant-time verify (belt-and-braces over the indexed equality lookup) so the
  // hash-compare code path carries no timing signal distinguishing token values.
  if (!install || !constantTimeEqual(install.token_sha256, digest)) {
    return { ok: false, reason: 'UNKNOWN' };
  }
  if (install.revoked_at !== null) return { ok: false, reason: 'REVOKED' };
  return { ok: true, install };
}
