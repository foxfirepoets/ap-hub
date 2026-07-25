import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../src/auth/session.js';
import { assessProviderCapabilities } from '../src/accounting/capabilities.js';
import { listProviderCapabilities, runRead } from '../src/services/read/index.js';
import { query } from '../src/db/pool.js';
import {
  closeAll,
  createConnection,
  createTenant,
  createUser,
  resetTables,
} from './helpers.js';

async function setMetadata(
  connectionId: number,
  metadata: Record<string, unknown>,
): Promise<void> {
  await query('UPDATE connections SET metadata=$1 WHERE id=$2', [metadata, connectionId]);
}

function bearer(token: string): Request {
  return new Request('http://localhost/api/provider-capabilities', {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('CHUNK_2_CAPABILITIES — executable matrix', () => {
  it('supports certified QBO editions and declares field gaps', () => {
    for (const edition of ['simple start', 'essentials', 'plus', 'advanced', 'accountant']) {
      const result = assessProviderCapabilities({
        provider: 'qbo',
        connectionClass: 'cloud',
        edition,
      });
      expect(result.supported).toBe(true);
      expect(result.capabilities.every((capability) => capability.supported)).toBe(true);
      expect(result.capabilities[0]!.unsupportedFields).toContain('desktop_inventory_site');
    }
  });

  it('supports only Windows QBD Pro, Premier, and Enterprise', () => {
    for (const edition of ['Pro', 'Premier', 'Enterprise']) {
      const result = assessProviderCapabilities({
        provider: 'qbd',
        connectionClass: 'local_desktop',
        edition,
        platform: 'windows',
      });
      expect(result.supported).toBe(true);
      expect(result.capabilities.map((capability) => capability.operation)).toContain('post_bill');
      expect(result.capabilities.find((capability) => capability.operation === 'post_bill')?.supported).toBe(true);
      expect(result.capabilities.find((capability) => capability.operation === 'attach')).toMatchObject({
        supported: false,
        reason: expect.stringContaining('not certified'),
      });
    }

    const mac = assessProviderCapabilities({
      provider: 'qbd',
      connectionClass: 'local_desktop',
      edition: 'Premier',
      platform: 'mac',
    });
    expect(mac.supported).toBe(false);
    expect(mac.gaps[0]).toContain('supported Windows company');
  });

  it('fails closed for incompatible editions, providers, and inactive connections', () => {
    const selfEmployed = assessProviderCapabilities({
      provider: 'qbo',
      connectionClass: 'cloud',
      edition: 'Self-Employed',
    });
    expect(selfEmployed.supported).toBe(false);
    expect(selfEmployed.capabilities.every((capability) => capability.supported === false)).toBe(true);
    expect(selfEmployed.gaps[0]).toContain('not certified');

    const mac = assessProviderCapabilities({
      provider: 'qbd',
      connectionClass: 'local_desktop',
      edition: 'Mac',
      platform: 'windows',
    });
    expect(mac.gaps[0]).toContain('Pro, Premier, or Enterprise');

    const other = assessProviderCapabilities({
      provider: 'xero',
      connectionClass: 'cloud',
    });
    expect(other.gaps[0]).toContain('QuickBooks Online');

    const revoked = assessProviderCapabilities({
      provider: 'qbo',
      connectionClass: 'cloud',
      edition: 'Plus',
      status: 'revoked',
    });
    expect(revoked.gaps[0]).toContain('reconnect or reactivate');
  });
});

describe('CHUNK_2_CAPABILITIES — tenant API service', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('returns only the authenticated tenant connections and exact capability results', async () => {
    const tenantA = await createTenant('A');
    const tenantB = await createTenant('B');
    const qbo = await createConnection(tenantA, { provider: 'qbo', connectionClass: 'cloud' });
    const qbd = await createConnection(tenantA, {
      provider: 'qbd',
      connectionClass: 'local_desktop',
    });
    const foreign = await createConnection(tenantB, { provider: 'qbo', connectionClass: 'cloud' });
    await setMetadata(qbo, { edition: 'Plus', lastVerifiedAt: '2026-07-24T12:00:00Z' });
    await setMetadata(qbd, { edition: 'Enterprise', platform: 'windows' });
    await setMetadata(foreign, { edition: 'Advanced' });

    const result = await listProviderCapabilities(tenantA);
    expect(result.connections.map((connection) => connection.id)).toEqual(
      [qbo, qbd].map(Number),
    );
    expect(result.connections.every((connection) => connection.supported)).toBe(true);
    expect(result.connections[0]!.lastVerifiedAt).toBe('2026-07-24T12:00:00Z');
  });

  it.each(['owner_controller', 'bookkeeper', 'cpa'])(
    'allows the %s read role',
    async (role) => {
      const tenant = await createTenant(role);
      const user = await createUser(tenant, { role });
      const session = await createSession(user);
      const response = await runRead(
        bearer(session.token),
        (ctx) => listProviderCapabilities(ctx.tenantId),
        { role: ['owner_controller', 'bookkeeper', 'cpa'] },
      );
      expect(response.status).toBe(200);
    },
  );

  it('rejects unauthenticated and unrecognized roles', async () => {
    const noSession = await runRead(
      new Request('http://localhost/api/provider-capabilities'),
      (ctx) => listProviderCapabilities(ctx.tenantId),
      { role: ['owner_controller', 'bookkeeper', 'cpa'] },
    );
    expect(noSession.status).toBe(401);

    const tenant = await createTenant('invalid-role');
    const user = await createUser(tenant, { role: 'admin' });
    const session = await createSession(user);
    const forbidden = await runRead(
      bearer(session.token),
      (ctx) => listProviderCapabilities(ctx.tenantId),
      { role: ['owner_controller', 'bookkeeper', 'cpa'] },
    );
    expect(forbidden.status).toBe(403);
  });
});
