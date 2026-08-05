/**
 * Production connector factory (F4). The core pipeline calls this — NOT a provider write
 * module — so `src/pipeline/**` never imports `src/qbo/**`. This module (under
 * src/connectors/**) is the one place allowed to construct the QBO clients and wrap them
 * in the provider-neutral connector (delegation only; write.ts logic untouched).
 */

import { config } from '../config.js';
import { getQboWriteClient } from '../qbo/write.js';
import { getQboReadClient } from '../qbo/client.js';
import { createQboConnector } from './qbo.js';
import { xeroConnectorFromToken } from './xero.js';
import type { AccountingConnector } from './types.js';
import { query } from '../db/pool.js';
import { ownerGateEnabled } from '../accounting/write-gates.js';
import { getFreshXeroToken } from '../auth/xero-refresh.js';

/** Build the QBO connector for a tenant, wired to config + stored tokens. */
export async function getQboConnector(tenantId: number): Promise<AccountingConnector> {
  const cfg = config();
  const expectedRealm = cfg.QBO_ENV === 'production'
    ? cfg.QBO_PRODUCTION_REALM_ID : cfg.QBO_SANDBOX_REALM_ID;
  const connection = (await query<{ external_company: string | null; status: string; metadata: Record<string, unknown> }>(
    `SELECT external_company,status,metadata FROM connections
      WHERE tenant_id=$1 AND provider='qbo' AND connection_class='cloud'
      ORDER BY updated_at DESC,id DESC LIMIT 1`,
    [tenantId],
  )).rows[0];
  if (!connection || connection.status !== 'active') throw new Error('QBO_CONNECTION_UNAVAILABLE');
  if (!ownerGateEnabled(connection.metadata, connection.external_company ?? '')) {
    throw new Error('QBO_OWNER_WRITE_GATE_DISABLED');
  }
  if (
    (cfg.QBO_ENV === 'production' &&
      (!expectedRealm || connection.external_company !== expectedRealm)) ||
    (cfg.QBO_ENV === 'sandbox' &&
      Boolean(expectedRealm) &&
      connection.external_company !== expectedRealm)
  ) {
    throw new Error('QBO_REALM_IDENTITY_MISMATCH');
  }
  const writeClient = await getQboWriteClient(tenantId);
  const readClient = await getQboReadClient(tenantId);
  return createQboConnector({
    writeClient,
    readClient,
    expectedCompanyName: (cfg.QBO_ENV === 'production'
      ? cfg.QBO_PRODUCTION_COMPANY_NAME : cfg.QBO_SANDBOX_COMPANY_NAME).trim() || undefined,
  });
}

/**
 * Provider-neutral connector dispatcher (CHUNK_10 Task 5): resolves the tenant's active
 * cloud connection WITHOUT hardcoding a provider, then builds the matching connector.
 * `src/pipeline/**` calls only this — never a provider-specific factory function directly
 * — so the live posting path stays provider-neutral (lint:noleak enforced).
 */
export async function getConnectorForProvider(tenantId: number): Promise<AccountingConnector> {
  const connection = (await query<{ provider: string }>(
    `SELECT provider FROM connections
      WHERE tenant_id=$1 AND connection_class='cloud' AND status='active'
      ORDER BY updated_at DESC,id DESC LIMIT 1`,
    [tenantId],
  )).rows[0];
  if (!connection) throw new Error('NO_ACTIVE_CLOUD_CONNECTION');

  if (connection.provider === 'qbo') return getQboConnector(tenantId);

  if (connection.provider === 'xero') {
    const cfg = config();
    // getFreshXeroToken transparently refreshes an expired/near-expiry access token
    // (30-min lifetime) via src/auth/xero-refresh.ts, mirroring getQboWriteClient/
    // getQboReadClient's use of getFreshQboToken above — never a stale token as-is.
    // Its distinct errors ("xero not connected for tenant" / "xero token refresh failed:
    // {status}" / a malformed-response error) propagate as-is, exactly like the QBO branch
    // above never wraps getFreshQboToken's own errors — collapsing them into one generic
    // string would lose the difference between "never connected", "refresh rejected (needs
    // re-auth)", and "Xero's token endpoint is down (retry later)".
    const tok = await getFreshXeroToken(tenantId);
    return xeroConnectorFromToken(
      {
        accessToken: tok.accessToken,
        tenantId: tok.realm ?? '',
        env: cfg.XERO_PRODUCTION_WRITE_ENABLED ? 'production' : 'demo',
        productionWriteEnabled: cfg.XERO_PRODUCTION_WRITE_ENABLED,
      },
      cfg.XERO_EXPECTED_COMPANY_NAME.trim() || undefined,
    );
  }

  throw new Error('NO_ACTIVE_CLOUD_CONNECTION');
}
