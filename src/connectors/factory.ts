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
import type { AccountingConnector } from './types.js';
import { query } from '../db/pool.js';
import { ownerGateEnabled } from '../accounting/write-gates.js';

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
