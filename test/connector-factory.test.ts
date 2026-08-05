import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getConnectorForProvider } from '../src/connectors/factory.js';
import { saveToken } from '../src/auth/tokens.js';
import { resetTables, createTenant, createConnection, closeAll } from './helpers.js';

/**
 * FMA finding F1 (2026-07-29): getConnectorForProvider's xero branch used to swallow every
 * getFreshXeroToken failure into one generic 'XERO_CONNECTION_UNAVAILABLE' string — unlike its
 * own qbo branch in the same function, which propagates QBO_CONNECTION_UNAVAILABLE /
 * QBO_OWNER_WRITE_GATE_DISABLED / QBO_REALM_IDENTITY_MISMATCH as distinct typed errors. These
 * tests lock in the fix: a "never connected" tenant and a real, resolvable connector are
 * distinguishable failure/success paths, not one flattened error.
 */
describe('getConnectorForProvider — xero branch propagates distinct errors (FMA F1)', () => {
  beforeEach(() => resetTables());
  afterAll(closeAll);

  it('throws no active cloud connection when nothing is connected', async () => {
    const t = await createTenant();
    await expect(getConnectorForProvider(t)).rejects.toThrow('NO_ACTIVE_CLOUD_CONNECTION');
  });

  it('propagates xero-refresh.ts\'s own "not connected" error verbatim, not a generic wrapper', async () => {
    const t = await createTenant();
    // An active xero connection row exists, but no oauth token was ever saved for it —
    // exercises getFreshXeroToken's real "Xero not connected for tenant" failure.
    await createConnection(t, { provider: 'xero', connectionClass: 'cloud', externalCompany: 'tenant-guid-1' });
    await expect(getConnectorForProvider(t)).rejects.toThrow('xero not connected for tenant');
  });

  it('resolves a real xero connector once a token is stored', async () => {
    const t = await createTenant();
    await createConnection(t, { provider: 'xero', connectionClass: 'cloud', externalCompany: 'tenant-guid-1' });
    await saveToken(t, 'xero', {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: new Date(Date.now() + 1800_000),
      scope: 'accounting.contacts',
      realm: 'tenant-guid-1',
    });
    const connector = await getConnectorForProvider(t);
    expect(connector.provider).toBe('xero');
  });
});
