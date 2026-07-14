import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '../crypto.js';
import { config } from '../config.js';
import { query } from '../db/pool.js';

/**
 * Session store (CHUNK_1_AUTH). A session is a random 256-bit token handed to the
 * browser in an httpOnly cookie; the database stores ONLY sha256(token). Validation
 * hash-compares, then checks expiry, revocation, and the owning user's status.
 *
 * The raw token is never persisted and never logged (see logger redaction).
 */

export type SessionReason = 'not_found' | 'expired' | 'revoked' | 'user_disabled';

export interface ResolvedSession {
  sessionId: number;
  userId: number;
  tenantId: number;
  role: string;
  email: string;
  status: string;
}

export type ValidateResult =
  | { ok: true; session: ResolvedSession }
  | { ok: false; reason: SessionReason };

/** sha256 of the raw token — the only form ever stored. */
export function hashToken(rawToken: string): string {
  return sha256Hex(rawToken);
}

function ttlMs(): number {
  return config().SESSION_TTL_HOURS * 3600 * 1000;
}

export interface NewSession {
  id: number;
  token: string;
  expiresAt: Date;
}

/** Create a session for a user. Returns the raw token (shown once, then discarded). */
export async function createSession(userId: number): Promise<NewSession> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs());
  const { rows } = await query<{ id: number }>(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1,$2,$3) RETURNING id`,
    [userId, hashToken(token), expiresAt],
  );
  return { id: rows[0]!.id, token, expiresAt };
}

/** Hash-compare the raw token, then enforce expiry, revocation, and user status. */
export async function validateSession(rawToken: string): Promise<ValidateResult> {
  if (!rawToken) return { ok: false, reason: 'not_found' };
  const { rows } = await query<{
    session_id: number;
    user_id: number;
    tenant_id: number;
    role: string;
    email: string;
    status: string;
    revoked: boolean;
    expired: boolean;
  }>(
    `SELECT s.id AS session_id, s.revoked, (s.expires_at <= now()) AS expired,
            u.id AS user_id, u.tenant_id, u.role, u.email, u.status
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hashToken(rawToken)],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revoked) return { ok: false, reason: 'revoked' };
  if (row.expired) return { ok: false, reason: 'expired' };
  if (row.status !== 'active') return { ok: false, reason: 'user_disabled' };
  return {
    ok: true,
    session: {
      sessionId: row.session_id,
      userId: row.user_id,
      tenantId: row.tenant_id,
      role: row.role,
      email: row.email,
      status: row.status,
    },
  };
}

/** Revoke a session by id (used by logout and by disabling a user). */
export async function revokeSession(sessionId: number): Promise<void> {
  await query(`UPDATE sessions SET revoked = true WHERE id = $1`, [sessionId]);
}

/** Revoke the session identified by a raw token (logout convenience). */
export async function revokeSessionByToken(rawToken: string): Promise<void> {
  await query(`UPDATE sessions SET revoked = true WHERE token_hash = $1`, [hashToken(rawToken)]);
}

// --- Signed cookie helpers ---------------------------------------------------
// Cookie value = "<token>.<hmac>" where hmac = HMAC-SHA256(token, SESSION_COOKIE_SECRET).
// The signature detects tampering; the token itself is the session secret.

export const SESSION_COOKIE_NAME = 'aphub_session';

function sign(token: string): string {
  return createHmac('sha256', config().SESSION_COOKIE_SECRET).update(token).digest('base64url');
}

/** Produce the signed cookie value carried to the browser. */
export function signSessionValue(token: string): string {
  return `${token}.${sign(token)}`;
}

/** Verify a signed cookie value; returns the raw token, or null if tampered/malformed. */
export function verifySessionValue(value: string | undefined | null): string | null {
  if (!value) return null;
  const idx = value.lastIndexOf('.');
  if (idx <= 0) return null;
  const token = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  const expected = sign(token);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return token;
}

/** Build a Set-Cookie header string for a fresh session. */
export function buildSessionCookie(token: string, expiresAt: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [
    `${SESSION_COOKIE_NAME}=${signSessionValue(token)}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

/** Build a Set-Cookie header string that clears the session cookie (logout). */
export function buildClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Extract the raw session cookie value from a Cookie header, verifying its signature. */
export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE_NAME) {
      return verifySessionValue(part.slice(eq + 1).trim());
    }
  }
  return null;
}
