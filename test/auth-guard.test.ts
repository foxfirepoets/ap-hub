import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { query } from '../src/db/pool.js';
import { requireSession, requirePermission, AuthError } from '../src/auth/guard.js';
import { createSession } from '../src/auth/session.js';
import { completeLogin } from '../src/auth/google-sso.js';
import { scopedQuery, TenantScopeError } from '../src/db/scoped.js';
import { resetTables, createTenant, createUser, countRows, closeAll } from './helpers.js';

beforeEach(resetTables);
afterAll(closeAll);

async function tokenFor(tenantId: number, opts: Parameters<typeof createUser>[1] = {}) {
  const u = await createUser(tenantId, opts);
  const { token } = await createSession(u);
  return { token, userId: u };
}

describe('requireSession', () => {
  it('401 UNAUTHENTICATED when no token is supplied', async () => {
    await expect(requireSession(null)).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('401 UNAUTHENTICATED for an unknown token', async () => {
    await expect(requireSession('garbage')).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('resolves an AuthContext scoped to the session tenant', async () => {
    const t = await createTenant();
    const { token, userId } = await tokenFor(t, { role: 'cpa' });
    const ctx = await requireSession(token);
    expect(ctx).toMatchObject({ tenantId: t, userId, role: 'cpa' });
  });

  it('403 FORBIDDEN when the role is not allowed', async () => {
    const t = await createTenant();
    const { token } = await tokenFor(t, { role: 'bookkeeper' });
    await expect(requireSession(token, 'owner_controller')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
  });

  it('allows a role present in the allowed set', async () => {
    const t = await createTenant();
    const { token } = await tokenFor(t, { role: 'bookkeeper' });
    const ctx = await requireSession(token, ['owner_controller', 'bookkeeper']);
    expect(ctx.role).toBe('bookkeeper');
  });

  it('401 SESSION_EXPIRED for an expired session', async () => {
    const t = await createTenant();
    const u = await createUser(t);
    const { token, id } = await createSession(u);
    await query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id=$1", [id]);
    await expect(requireSession(token)).rejects.toMatchObject({ status: 401, code: 'SESSION_EXPIRED' });
  });

  it('401 for a disabled user', async () => {
    const t = await createTenant();
    const u = await createUser(t, { status: 'disabled' });
    const { token } = await createSession(u);
    const err = await requireSession(token).catch((e) => e as AuthError);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(401);
  });
});

describe('requirePermission', () => {
  it('throws 403 when the role lacks the permission', async () => {
    const t = await createTenant();
    const { token } = await tokenFor(t, { role: 'cpa' });
    const ctx = await requireSession(token);
    expect(() => requirePermission(ctx, 'approve')).toThrow(AuthError);
    expect(() => requirePermission(ctx, 'read')).not.toThrow();
  });
});

describe('scopedQuery tenant isolation', () => {
  it('cannot see another tenant\'s row (cross-tenant → empty → 404 at the route)', async () => {
    const a = await createTenant('A');
    const b = await createTenant('B');
    const ub = await createUser(b, { email: 'b@example.com' });
    // Tenant A queries for tenant B's user id — scoped by A, sees nothing.
    const res = await scopedQuery(a, 'SELECT id FROM users WHERE tenant_id = $1 AND id = $2', [ub]);
    expect(res.rows.length).toBe(0);
    // Tenant B sees its own row.
    const own = await scopedQuery(b, 'SELECT id FROM users WHERE tenant_id = $1 AND id = $2', [ub]);
    expect(own.rows.length).toBe(1);
  });

  it('throws when tenantId is missing', async () => {
    await expect(
      scopedQuery(undefined as unknown as number, 'SELECT 1 FROM users WHERE tenant_id = $1'),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('throws when the SQL forgets its tenant_id filter', async () => {
    await expect(scopedQuery(1, 'SELECT 1 FROM users')).rejects.toBeInstanceOf(TenantScopeError);
  });
});

describe('completeLogin (SSO activate pre-invited user + session)', () => {
  it('activates a pre-invited user on first login and mints a session', async () => {
    const t = await createTenant();
    await createUser(t, { email: 'inv@example.com', status: 'invited' });
    const r = await completeLogin(t, { sub: 'g-123', email: 'inv@example.com', name: 'Inv User' });
    expect(r.tenantId).toBe(t);
    expect(await countRows('users', "tenant_id=$1 AND email='inv@example.com' AND status='active'", [t])).toBe(1);
    const ctx = await requireSession(r.session.token);
    expect(ctx.email).toBe('inv@example.com');
    expect(ctx.tenantId).toBe(t);
  });

  it('REFUSES a stranger with no invite — no user created, no session (cross-tenant self-provision is blocked)', async () => {
    const t = await createTenant();
    await expect(
      completeLogin(t, { sub: 'g-x', email: 'stranger@evil.com', name: 'Attacker' }),
    ).rejects.toThrow(/no invited account/);
    expect(await countRows('users', "tenant_id=$1 AND email='stranger@evil.com'", [t])).toBe(0);
    expect(await countRows('sessions')).toBe(0);
  });

  it('re-login of the same active user does not create a duplicate user', async () => {
    const t = await createTenant();
    await createUser(t, { email: 'dup@example.com', status: 'invited' });
    await completeLogin(t, { sub: 'g-1', email: 'dup@example.com' });
    await completeLogin(t, { sub: 'g-1', email: 'dup@example.com' });
    expect(await countRows('users', 'tenant_id=$1', [t])).toBe(1);
  });

  it('refuses a disabled user (no session minted)', async () => {
    const t = await createTenant();
    await createUser(t, { email: 'off@example.com', status: 'disabled' });
    await expect(completeLogin(t, { sub: 'g-2', email: 'off@example.com' })).rejects.toThrow(/disabled/);
    expect(await countRows('sessions')).toBe(0);
  });

  it('writes an auth.login audit row with the human actor', async () => {
    const t = await createTenant();
    await createUser(t, { email: 'actor@example.com', status: 'invited' });
    await completeLogin(t, { sub: 'g-3', email: 'actor@example.com' });
    const n = await countRows('audit_log', "tenant_id=$1 AND action='auth.login' AND actor='actor@example.com'", [t]);
    expect(n).toBe(1);
  });
});
