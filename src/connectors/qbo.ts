/**
 * QBO reference AccountingConnector (CHUNK_5). This adapter WRAPS the existing
 * `src/qbo/write.ts` + `src/qbo/client.ts` — delegation only, ZERO logic change to
 * write.ts. It translates the provider-neutral canonical model to/from QBO objects and
 * exposes QBO's capability matrix. All QBO-specific naming lives here (connectors/**),
 * never in core.
 */

import { createQboWriteClient, type QboWriteClient, type QboWriteDeps } from '../qbo/write.js';
import { createQboReadClient, type QboReadClient, type QboReadDeps } from '../qbo/client.js';
import type {
  CanonicalBill,
  CanonicalRecord,
  CanonicalVendor,
  CanonicalAccount,
  CanonicalEntityKind,
  Unsupported,
} from '../canonical/model.js';
import type {
  AccountingConnector,
  AttachOk,
  CapabilityMatrix,
  CompanyIdentity,
  CreateResult,
  IdentityResult,
  PostingTxn,
  PostedRef,
  ReadBackResult,
} from './types.js';
import { evaluateTax } from '../mapping/tax.js';
import { mappedSupportedDimensions, SUPPORTED_DIMENSION_KINDS } from '../mapping/dimensions.js';
import type { CanonicalDimension } from '../canonical/model.js';

/** Dimension kinds QBO can represent. Anything else is surfaced as Unsupported. */
const QBO_DIMENSIONS = ['class', 'location'];

// --- QBO-specific translation of the pipeline's opaque PostingTxn. All of this used to
// live in src/pipeline/posting.ts; F4 moved it into the adapter so the core pipeline holds
// no QBO shapes and imports no QBO write module. ---

function qboDedupWhere(txn: any): string | null {
  const vendor = txn?.vendorRef?.value;
  const doc = txn?.DocNumber;
  if (!vendor && !doc) return null;
  const parts: string[] = [];
  if (doc) parts.push(`DocNumber = '${String(doc).replace(/'/g, '')}'`);
  if (txn?.TxnDate) parts.push(`TxnDate = '${String(txn.TxnDate).replace(/'/g, '')}'`);
  return parts.join(' AND ') || null;
}

function qboPostingPayload(txn: any): Record<string, unknown> {
  const headerDims = mappedSupportedDimensions(txn.dimensions);
  const headerClass = headerDims.find((d) => d.kind === 'class');
  const headerLocation = headerDims.find((d) => d.kind === 'location');
  const lines = (txn.lines ?? []).map((l: any) => {
    const detail: Record<string, unknown> = l.accountRef ? { AccountRef: { value: l.accountRef.value } } : {};
    const lineDims = mappedSupportedDimensions(l.dimensions);
    const cls = lineDims.find((d) => d.kind === 'class') ?? headerClass;
    if (cls?.id) detail.ClassRef = { value: cls.id };
    return { Amount: l.Amount, DetailType: 'AccountBasedExpenseLineDetail', Description: l.description, AccountBasedExpenseLineDetail: detail };
  });
  const fallbackDetail: Record<string, unknown> = {};
  if (headerClass?.id) fallbackDetail.ClassRef = { value: headerClass.id };
  const payload: Record<string, unknown> = {
    Line: lines.length ? lines : [{ Amount: txn.TotalAmt, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: fallbackDetail }],
    TxnDate: txn.TxnDate,
    DocNumber: txn.DocNumber,
  };
  if (txn.DueDate) payload.DueDate = txn.DueDate;
  if (txn.vendorRef) payload.VendorRef = { value: txn.vendorRef.value };
  if (headerLocation?.id) payload.DepartmentRef = { value: headerLocation.id };
  const tax = evaluateTax(txn);
  if (tax.kind === 'ok' && tax.tax.code) {
    payload.TxnTaxDetail = { TotalTax: tax.tax.amount, TxnTaxCodeRef: { value: String(tax.tax.code) } };
  }
  return payload;
}

function qboAmountDocMatches(txn: any, readBack: any): boolean {
  const amtA = Number(txn?.TotalAmt ?? 0);
  const amtB = Number(readBack?.TotalAmt ?? 0);
  if (Math.abs(amtA - amtB) > 0.01) return false;
  if (txn?.DocNumber && readBack?.DocNumber && String(txn.DocNumber) !== String(readBack.DocNumber)) return false;
  return true;
}

function qboReadBackDimensionValue(kind: string, readBack: any): string | undefined {
  if (kind === 'location') {
    const v = readBack?.DepartmentRef?.value;
    return v == null ? undefined : String(v);
  }
  if (kind === 'class') {
    const lines: any[] = Array.isArray(readBack?.Line) ? readBack.Line : [];
    for (const l of lines) {
      const v = l?.AccountBasedExpenseLineDetail?.ClassRef?.value;
      if (v != null) return String(v);
    }
    const headerV = readBack?.ClassRef?.value;
    return headerV == null ? undefined : String(headerV);
  }
  return undefined;
}

function qboFirstDimensionMismatch(txn: any, readBack: any): { kind: string; expected: string; found: string | null } | null {
  const dims: CanonicalDimension[] = [
    ...mappedSupportedDimensions(txn?.dimensions),
    ...(Array.isArray(txn?.lines) ? txn.lines.flatMap((l: any) => mappedSupportedDimensions(l?.dimensions)) : []),
  ].filter((d) => SUPPORTED_DIMENSION_KINDS.includes(d.kind as (typeof SUPPORTED_DIMENSION_KINDS)[number]));
  for (const d of dims) {
    if (!d.id) continue;
    const found = qboReadBackDimensionValue(d.kind, readBack);
    if (found !== String(d.id)) return { kind: d.kind, expected: String(d.id), found: found ?? null };
  }
  return null;
}

export interface QboConnectorDeps {
  writeClient: QboWriteClient;
  readClient: QboReadClient;
  /** Company name to match in verifyCompanyIdentity (from config/onboarding). */
  expectedCompanyName?: string;
  /** Audit hook invoked for every Unsupported field (never silently dropped). */
  onUnsupported?: (u: Unsupported) => void;
}

export function createQboConnector(deps: QboConnectorDeps): AccountingConnector {
  const { writeClient, readClient, onUnsupported } = deps;

  function capabilities(): CapabilityMatrix {
    return {
      read: ['vendor', 'account'],
      write: ['bill'],
      attachments: true,
      purchaseOrders: true,
      itemReceipts: false,
      dimensions: [...QBO_DIMENSIONS],
      multiCurrency: false,
      multiEntity: false,
      changeFeed: 'webhook',
      idempotency: 'native',
      unsupported: [],
    };
  }

  function gapsFor(bill: CanonicalBill): Unsupported[] {
    const gaps: Unsupported[] = [];
    const allDims = [
      ...(bill.dimensions ?? []),
      ...bill.lines.flatMap((l) => l.dimensions ?? []),
    ];
    for (const d of allDims) {
      if (!QBO_DIMENSIONS.includes(d.kind)) {
        const u: Unsupported = {
          unsupported: true,
          field: `dimensions.${d.kind}`,
          reason: `QBO cannot represent dimension "${d.kind}" (supports: ${QBO_DIMENSIONS.join(', ')})`,
        };
        gaps.push(u);
        onUnsupported?.(u);
      }
    }
    if (bill.currency && capabilities().multiCurrency === false) {
      const u: Unsupported = {
        unsupported: true,
        field: 'currency',
        reason: 'QBO connector operates single-currency in this phase',
      };
      gaps.push(u);
      onUnsupported?.(u);
    }
    return gaps;
  }

  function billToQboPayload(bill: CanonicalBill): Record<string, unknown> {
    const line = bill.lines.length
      ? bill.lines.map((l) => ({
          Amount: Number(l.amount),
          DetailType: 'AccountBasedExpenseLineDetail',
          Description: l.description,
          AccountBasedExpenseLineDetail: l.accountId ? { AccountRef: { value: l.accountId } } : {},
        }))
      : [{ Amount: Number(bill.total), DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: {} }];
    const payload: Record<string, unknown> = {
      Line: line,
      TxnDate: bill.txnDate,
      DocNumber: bill.docNumber,
    };
    if (bill.vendorId) payload.VendorRef = { value: bill.vendorId };
    return payload;
  }

  return {
    provider: 'qbo',
    connectionClass: 'cloud',
    companyId: writeClient.realm,
    capabilities,

    async verifyCompanyIdentity(expected: CompanyIdentity): Promise<IdentityResult> {
      const info = await readClient.getCompanyInfo();
      const actual = String(info?.CompanyName ?? '').trim();
      return actual && actual === expected.name.trim() ? 'match' : 'mismatch';
    },

    async read(entity: CanonicalEntityKind): Promise<CanonicalRecord[]> {
      if (entity === 'vendor') {
        const rows = await readClient.queryEntity<Record<string, unknown>>('Vendor');
        return rows.map((r) => {
          const v: CanonicalVendor = { id: String((r as any).Id ?? ''), name: String((r as any).DisplayName ?? (r as any).CompanyName ?? '') };
          return { kind: 'vendor', canonical: v, providerRaw: r };
        });
      }
      if (entity === 'account') {
        const rows = await readClient.queryEntity<Record<string, unknown>>('Account');
        return rows.map((r) => {
          const a: CanonicalAccount = {
            id: String((r as any).Id ?? ''),
            name: String((r as any).Name ?? ''),
            accountType: (r as any).AccountType,
          };
          return { kind: 'account', canonical: a, providerRaw: r };
        });
      }
      throw new Error(`QBO connector read('${entity}') is not implemented — declared read capability is 'vendor' and 'account' only.`);
    },

    async create(entity: CanonicalEntityKind, record: CanonicalRecord, idempotencyKey: string): Promise<CreateResult> {
      if (entity !== 'bill') throw new Error(`QBO connector create supports 'bill' only, got '${entity}'`);
      const bill = record.canonical as unknown as CanonicalBill;
      const gaps = gapsFor(bill);
      const created = await writeClient.createEntity('Bill', billToQboPayload(bill), idempotencyKey);
      return {
        external: { provider: 'qbo', id: created.id, revision: created.syncToken },
        capabilityGaps: gaps,
      };
    },

    async readBack(entity: CanonicalEntityKind, externalId: string): Promise<CanonicalRecord> {
      const raw = await writeClient.readEntity('Bill', externalId);
      const revision = String((raw as any).SyncToken ?? '0');
      return {
        kind: entity,
        canonical: raw,
        providerRaw: raw,
        external: { provider: 'qbo', id: externalId, revision },
      };
    },

    async attach(_entity: CanonicalEntityKind, externalId: string, doc: Buffer, filename: string): Promise<AttachOk | Unsupported> {
      await writeClient.attach('Bill', externalId, doc, filename);
      return { attached: true };
    },

    // --- F4 live posting operations (adapter owns all QBO translation) ---

    async detectExisting(txn: PostingTxn, _idempotencyKey: string): Promise<PostedRef | null> {
      const txnType = String((txn as any).txnType ?? 'Bill');
      const where = qboDedupWhere(txn);
      if (!where) return null;
      // Propagates on error → the pipeline holds fail-closed (dedup_unavailable).
      const rows = await writeClient.queryExisting(txnType, where);
      if (rows.length === 0) return null;
      const raw = rows[0] as Record<string, unknown>;
      return { externalId: String((raw as any).Id ?? ''), revision: String((raw as any).SyncToken ?? '0'), raw };
    },

    async postBill(txn: PostingTxn, idempotencyKey: string): Promise<PostedRef> {
      const txnType = String((txn as any).txnType ?? 'Bill');
      const created = await writeClient.createEntity(txnType, qboPostingPayload(txn), idempotencyKey);
      return { externalId: created.id, revision: created.syncToken, raw: created.entity };
    },

    async attachDocument(externalId: string, doc: Buffer, filename: string): Promise<void> {
      await writeClient.attach('Bill', externalId, doc, filename);
    },

    async readBackVerify(txn: PostingTxn, externalId: string): Promise<ReadBackResult> {
      const txnType = String((txn as any).txnType ?? 'Bill');
      const raw = (await writeClient.readEntity(txnType, externalId)) as Record<string, unknown>;
      const revision = String((raw as any).SyncToken ?? '0');
      if (!qboAmountDocMatches(txn, raw)) {
        const amtOk = Math.abs(Number((txn as any)?.TotalAmt ?? 0) - Number((raw as any)?.TotalAmt ?? 0)) <= 0.01;
        return { verify: 'mismatch', reason: amtOk ? 'docnumber' : 'amount', revision, raw };
      }
      const dimMiss = qboFirstDimensionMismatch(txn, raw);
      if (dimMiss) return { verify: 'mismatch', reason: 'dimension', detail: dimMiss, revision, raw };
      return { verify: 'match', revision, raw };
    },

    async close(): Promise<void> {
      /* stateless HTTP clients; nothing to close */
    },
  };
}

/** Build a QBO connector from raw client deps (production wiring). Delegation only. */
export function qboConnectorFromDeps(write: QboWriteDeps, read: QboReadDeps, expectedCompanyName?: string): AccountingConnector {
  return createQboConnector({
    writeClient: createQboWriteClient(write),
    readClient: createQboReadClient(read),
    expectedCompanyName,
  });
}
