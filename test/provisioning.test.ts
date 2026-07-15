import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { bootstrapTenant } from '../src/services/provisioning.js';
import { completeLogin } from '../src/auth/google-sso.js';
import { resetTables, countRows, closeAll } from './helpers.js';

beforeEach(resetTables);
afterAll(closeAll);

describe('bootstrapTenant (first-owner provisioning)', () => {
  it('creates a tenant and an invited owner_controller user', async () => {
    const res = await bootstrapTenant({ tenantName: 'Acme Co', ownerEmail: 'Owner@Acme.com', ownerName: 'Ada' });
    expect(Number(res.tenantId)).toBeGreaterThan(0);
    expect(Number(res.userId)).toBeGreaterThan(0);
    expect(res.ownerEmail).toBe('owner@acme.com');
    expect(
      await countRows(
        'users',
        "tenant_id=$1 AND id=$2 AND email='owner@acme.com' AND role='owner_controller' AND status='invited'",
        [res.tenantId, res.userId],
      ),
    ).toBe(1);
  });

  it('writes exactly one tenant.bootstrap audit_log row scoped to the new tenant', async () => {
    const res = await bootstrapTenant({ tenantName: 'Beta Co', ownerEmail: 'owner@beta.com' });
    expect(
      await countRows('audit_log', "tenant_id=$1 AND action='tenant.bootstrap'", [res.tenantId]),
    ).toBe(1);
  });

  it('rejects a blank tenant name', async () => {
    await expect(bootstrapTenant({ tenantName: '  ', ownerEmail: 'a@b.com' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('rejects a malformed owner email', async () => {
    await expect(bootstrapTenant({ tenantName: 'Gamma Co', ownerEmail: 'not-an-email' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('the bootstrapped owner can then complete SSO login (the whole point of the fix)', async () => {
    const res = await bootstrapTenant({ tenantName: 'Delta Co', ownerEmail: 'owner@delta.com' });
    const login = await completeLogin(res.tenantId, { sub: 'g-first-owner', email: 'owner@delta.com', name: 'D' });
    expect(login.tenantId).toBe(res.tenantId);
    expect(login.role).toBe('owner_controller');
    expect(
      await countRows('users', "id=$1 AND status='active'", [res.userId]),
    ).toBe(1);
  });
});
