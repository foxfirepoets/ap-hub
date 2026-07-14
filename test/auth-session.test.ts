import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { query } from '../src/db/pool.js';
import {
  createSession,
  validateSession,
  revokeSession,
  revokeSessionByToken,
  hashToken,
  signSessionValue,
  verifySessionValue,
  buildSessionCookie,
  readSessionCookie,
  SESSION_COOKIE_NAME,
} from '../src/auth/session.js';
import { can, ROLE_PERMISSIONS } from '../src/auth/guard.js';
import { resetTables, createTenant, createUser, closeAll } from './helpers.js';

beforeEach(resetTables);
afterAll(closeAll);

describe('session token hashing + storage', () => {
  it('hashToken is deterministic and one-way (differs per input)', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
    expect(hashToken('abc')).not.toContain('abc');
  });

  it('createSession stores only the hash, never the raw token', async () => {
    const t = await createTenant();
    const u = await createUser(t);
    const { id, token } = await createSession(u);
    const { rows } = await query<{ token_hash: string }>(
      'SELECT token_hash FROM sessions WHERE id=$1',
      [id],
    );
    expect(rows[0]!.token_hash).toBe(hashToken(token));
    expect(rows[0]!.token_hash).not.toBe(token);
  });
});

describe('validateSession', () => {
  it('accepts a fresh session and resolves tenant + role', async () => {
    const t = await createTenant();
    const u = await createUser(t, { role: 'bookkeeper', email: 'bk@example.com' });
    const { token } = await createSession(u);
    const res = await validateSession(token);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.session.tenantId).toBe(t);
      expect(res.session.role).toBe('bookkeeper');
      expect(res.session.email).toBe('bk@example.com');
    }
  });

  it('rejects an unknown token', async () => {
    const res = await validateSession('nope');
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects an expired session', async () => {
    const t = await createTenant();
    const u = await createUser(t);
    const { token, id } = await createSession(u);
    await query('UPDATE sessions SET expires_at = now() - interval \'1 hour\' WHERE id=$1', [id]);
    const res = await validateSession(token);
    expect(res).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a revoked session', async () => {
    const t = await createTenant();
    const u = await createUser(t);
    const { token, id } = await createSession(u);
    await revokeSession(id);
    expect(await validateSession(token)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('rejects a disabled user mid-session', async () => {
    const t = await createTenant();
    const u = await createUser(t, { status: 'active' });
    const { token } = await createSession(u);
    expect((await validateSession(token)).ok).toBe(true);
    await query("UPDATE users SET status='disabled' WHERE id=$1", [u]);
    expect(await validateSession(token)).toEqual({ ok: false, reason: 'user_disabled' });
  });

  it('revokeSessionByToken invalidates the matching session', async () => {
    const t = await createTenant();
    const u = await createUser(t);
    const { token } = await createSession(u);
    await revokeSessionByToken(token);
    expect((await validateSession(token)).ok).toBe(false);
  });
});

describe('signed session cookie', () => {
  it('round-trips a token through sign/verify', () => {
    const signed = signSessionValue('rawtoken123');
    expect(signed).toContain('.');
    expect(verifySessionValue(signed)).toBe('rawtoken123');
  });

  it('rejects a tampered signature', () => {
    const signed = signSessionValue('rawtoken123');
    expect(verifySessionValue(signed + 'x')).toBeNull();
    expect(verifySessionValue('rawtoken123.badsig')).toBeNull();
    expect(verifySessionValue(undefined)).toBeNull();
  });

  it('buildSessionCookie is httpOnly + Secure + SameSite=Lax and readable back', () => {
    const cookie = buildSessionCookie('tok', new Date(Date.now() + 3600_000));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    const value = cookie.slice(`${SESSION_COOKIE_NAME}=`.length, cookie.indexOf(';'));
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=${value}`)).toBe('tok');
  });
});

describe('role → permission matrix', () => {
  it('owner_controller can approve/post; bookkeeper and cpa cannot', () => {
    expect(can('owner_controller', 'approve')).toBe(true);
    expect(can('bookkeeper', 'approve')).toBe(false);
    expect(can('cpa', 'approve')).toBe(false);
  });

  it('bookkeeper can reject/remap/learn but cpa is read-only', () => {
    expect(can('bookkeeper', 'reject')).toBe(true);
    expect(can('bookkeeper', 'remap')).toBe(true);
    expect(can('cpa', 'reject')).toBe(false);
    expect(can('cpa', 'read')).toBe(true);
    expect(ROLE_PERMISSIONS.cpa.size).toBe(1);
  });

  it('an unknown role holds no permissions', () => {
    expect(can('intruder', 'read')).toBe(false);
  });
});
