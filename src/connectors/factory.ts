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

/** Build the QBO connector for a tenant, wired to config + stored tokens. */
export async function getQboConnector(tenantId: number): Promise<AccountingConnector> {
  const cfg = config();
  const writeClient = await getQboWriteClient(tenantId);
  const readClient = await getQboReadClient(tenantId);
  return createQboConnector({
    writeClient,
    readClient,
    expectedCompanyName: (cfg.QBO_SANDBOX_COMPANY_NAME ?? '').trim() || undefined,
  });
}
