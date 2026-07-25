import { config } from '../config.js';
import { getFreshQboToken } from '../auth/qbo-refresh.js';

/**
 * QBO writer. Sandbox remains the default; production construction requires the
 * explicit production-write gate. Both modes retain the same idempotency,
 * provider-readback, and uncertain-result safeguards.
 */

const SANDBOX_BASE = 'https://sandbox-quickbooks.api.intuit.com';
const PRODUCTION_BASE = 'https://quickbooks.api.intuit.com';

export class ProductionWriteRefused extends Error {
  constructor() {
    super('QBO production writes require the explicit production write gate.');
    this.name = 'ProductionWriteRefused';
  }
}

export interface CreatedEntity {
  id: string;
  syncToken: string;
  entity: Record<string, unknown>;
}

export interface QboWriteClient {
  readonly realm: string;
  createEntity(type: string, payload: Record<string, unknown>, requestId: string): Promise<CreatedEntity>;
  readEntity(type: string, id: string): Promise<Record<string, unknown>>;
  queryExisting(type: string, where: string): Promise<Array<Record<string, unknown>>>;
  attach(txnType: string, txnId: string, pdf: Buffer, filename: string): Promise<void>;
}

export interface QboWriteDeps {
  qboEnv: string;
  productionWriteEnabled?: boolean;
  accessToken: string;
  realmId: string;
  minorVersion: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export function createQboWriteClient(deps: QboWriteDeps): QboWriteClient {
  if (!['sandbox', 'production'].includes(deps.qboEnv)) throw new ProductionWriteRefused();
  if (deps.qboEnv === 'production' && deps.productionWriteEnabled !== true) {
    throw new ProductionWriteRefused();
  }

  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const base = deps.baseUrl ?? (deps.qboEnv === 'production' ? PRODUCTION_BASE : SANDBOX_BASE);
  const realm = deps.realmId;

  const url = (path: string) =>
    `${base}/v3/company/${realm}/${path}${path.includes('?') ? '&' : '?'}minorversion=${deps.minorVersion}`;

  return {
    realm,
    async createEntity(type, payload, requestId) {
      const res = await fetchImpl(url(`${type.toLowerCase()}?requestid=${encodeURIComponent(requestId)}`), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deps.accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`QBO create ${type} → ${res.status}: ${text}`);
        (err as any).status = res.status;
        (err as any).body = text;
        throw err;
      }
      const data = (await res.json()) as any;
      const entity = data?.[type] ?? data?.[capitalize(type)] ?? {};
      return { id: String(entity.Id ?? ''), syncToken: String(entity.SyncToken ?? '0'), entity };
    },
    async readEntity(type, id) {
      const res = await fetchImpl(url(`${type.toLowerCase()}/${id}`), {
        method: 'GET',
        headers: { authorization: `Bearer ${deps.accessToken}`, accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`QBO read ${type}/${id} → ${res.status}`);
      const data = (await res.json()) as any;
      return data?.[type] ?? data?.[capitalize(type)] ?? {};
    },
    async queryExisting(type, where) {
      const q = `SELECT * FROM ${type} WHERE ${where}`;
      const res = await fetchImpl(url(`query?query=${encodeURIComponent(q)}`), {
        method: 'GET',
        headers: { authorization: `Bearer ${deps.accessToken}`, accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`QBO query ${type} → ${res.status}`);
      const data = (await res.json()) as any;
      return (data?.QueryResponse?.[type] ?? []) as Array<Record<string, unknown>>;
    },
    async attach(txnType, txnId, _pdf, filename) {
      // Creates the Attachable metadata/reference only — links a filename to the txn.
      // The file bytes (`_pdf`) are NOT uploaded: this sends JSON, not a multipart
      // body. Real multipart file upload is a follow-up (see CHUNK_7 notes).
      const meta = {
        AttachableRef: [{ EntityRef: { type: txnType, value: txnId } }],
        FileName: filename,
        ContentType: 'application/pdf',
      };
      const res = await fetchImpl(url('attachable'), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deps.accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(meta),
      });
      if (!res.ok) throw new Error(`QBO attach → ${res.status}`);
    },
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function getQboWriteClient(tenantId: number): Promise<QboWriteClient> {
  const cfg = config();
  // QBO access tokens expire (~60 min); refresh when expired/near-expiry before use.
  const tok = await getFreshQboToken(tenantId);
  const expectedRealm = cfg.QBO_ENV === 'production'
    ? cfg.QBO_PRODUCTION_REALM_ID : cfg.QBO_SANDBOX_REALM_ID;
  if (!tok.realm || (expectedRealm && tok.realm !== expectedRealm)) {
    throw new Error('QBO_TOKEN_REALM_IDENTITY_MISMATCH');
  }
  return createQboWriteClient({
    qboEnv: cfg.QBO_ENV,
    productionWriteEnabled: cfg.QBO_PRODUCTION_WRITE_ENABLED,
    accessToken: tok.accessToken,
    realmId: tok.realm,
    minorVersion: cfg.QBO_MINOR_VERSION,
  });
}
