import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { consumeSsoLoginState, createSsoLoginState } from '../src/auth/sso-state.js';
import { query } from '../src/db/pool.js';
import { closeAll, createTenant, resetTables } from './helpers.js';

describe('persistent SSO login state', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('resolves the server-side tenant exactly once', async () => {
    const tenantId = await createTenant();
    const state = await createSsoLoginState(tenantId);
    await expect(consumeSsoLoginState(state)).resolves.toBe(Number(tenantId));
    await expect(consumeSsoLoginState(state)).resolves.toBeNull();
  });

  it('rejects forged and expired states without exposing tenant in the token', async () => {
    const tenantId = await createTenant();
    const state = await createSsoLoginState(tenantId);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(consumeSsoLoginState(`${state}x`)).resolves.toBeNull();
    await query('UPDATE sso_login_states SET expires_at=now() - interval \'1 second\'');
    await expect(consumeSsoLoginState(state)).resolves.toBeNull();
  });
});
