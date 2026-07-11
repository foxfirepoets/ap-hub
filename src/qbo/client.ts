import { config } from '../config.js';
import { loadToken } from '../auth/tokens.js';

/**
 * READ-ONLY QuickBooks Online client (CHUNK_2). This module contains NO
 * create/update/delete method — QBO write capability does not exist until
 * CHUNK_7's separate `qbo/write.ts`. That absence is grep-verifiable and asserted
 * by the `no_qbo_write` test.
 *
 * All calls target the SANDBOX host; there is no production base URL here.
 */

const SANDBOX_BASE = 'https://sandbox-quickbooks.api.intuit.com';

export interface CompanyInfo {
  CompanyName: string;
  [k: string]: unknown;
}

export interface QboReadClient {
  getCompanyInfo(): Promise<CompanyInfo>;
  queryEntity<T = Record<string, unknown>>(entity: string, where?: string): Promise<T[]>;
}

export interface QboReadDeps {
  accessToken: string;
  realmId: string;
  minorVersion: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export function createQboReadClient(deps: QboReadDeps): QboReadClient {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const base = deps.baseUrl ?? SANDBOX_BASE;

  async function get(path: string): Promise<any> {
    const url = `${base}/v3/company/${deps.realmId}/${path}${path.includes('?') ? '&' : '?'}minorversion=${deps.minorVersion}`;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${deps.accessToken}`, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`QBO read ${path} → ${res.status}`);
    return res.json();
  }

  return {
    async getCompanyInfo(): Promise<CompanyInfo> {
      const data = await get(`companyinfo/${deps.realmId}`);
      return data?.CompanyInfo as CompanyInfo;
    },
    async queryEntity<T = Record<string, unknown>>(entity: string, where?: string): Promise<T[]> {
      const q = `SELECT * FROM ${entity}${where ? ` WHERE ${where}` : ''} MAXRESULTS 1000`;
      const data = await get(`query?query=${encodeURIComponent(q)}`);
      const rows = data?.QueryResponse?.[entity] ?? [];
      return rows as T[];
    },
  };
}

export async function getQboReadClient(tenantId: number): Promise<QboReadClient> {
  const cfg = config();
  const tok = await loadToken(tenantId, 'qbo');
  if (!tok) throw new Error('QBO not connected for tenant');
  return createQboReadClient({
    accessToken: tok.accessToken,
    realmId: tok.realm ?? cfg.QBO_SANDBOX_REALM_ID,
    minorVersion: cfg.QBO_MINOR_VERSION,
  });
}
