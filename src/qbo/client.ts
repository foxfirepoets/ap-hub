import { config } from '../config.js';
import { getFreshQboToken } from '../auth/qbo-refresh.js';

/**
 * READ-ONLY QuickBooks Online client (CHUNK_2). This module contains NO
 * create/update/delete method — QBO write capability does not exist until
 * CHUNK_7's separate `qbo/write.ts`. That absence is grep-verifiable and asserted
 * by the `no_qbo_write` test.
 *
 * The configured environment selects sandbox or production; write authorization remains separate.
 */

const SANDBOX_BASE = 'https://sandbox-quickbooks.api.intuit.com';
const PRODUCTION_BASE = 'https://quickbooks.api.intuit.com';

export interface CompanyInfo {
  CompanyName: string;
  [k: string]: unknown;
}

export interface QboReadClient {
  getCompanyInfo(): Promise<CompanyInfo>;
  queryEntity<T = Record<string, unknown>>(entity: string, where?: string): Promise<T[]>;
}

export interface QboReadDeps {
  qboEnv?: 'sandbox' | 'production';
  accessToken: string;
  realmId: string;
  minorVersion: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export function createQboReadClient(deps: QboReadDeps): QboReadClient {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const base = deps.baseUrl ?? (deps.qboEnv === 'production' ? PRODUCTION_BASE : SANDBOX_BASE);

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
  // QBO access tokens expire (~60 min); refresh when expired/near-expiry before use.
  const tok = await getFreshQboToken(tenantId);
  const expectedRealm = cfg.QBO_ENV === 'production'
    ? cfg.QBO_PRODUCTION_REALM_ID : cfg.QBO_SANDBOX_REALM_ID;
  if (!tok.realm || (expectedRealm && tok.realm !== expectedRealm)) {
    throw new Error('QBO_TOKEN_REALM_IDENTITY_MISMATCH');
  }
  return createQboReadClient({
    qboEnv: cfg.QBO_ENV,
    accessToken: tok.accessToken,
    realmId: tok.realm,
    minorVersion: cfg.QBO_MINOR_VERSION,
  });
}
