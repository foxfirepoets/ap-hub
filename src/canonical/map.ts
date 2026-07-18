/**
 * Canonical <-> stored-shape mapping helpers (CHUNK_5). Provider-neutral: this module
 * translates between the canonical AP model and the existing storage shapes
 * (`proposals.proposed_txn` JSONB + `mappings`) WITHOUT any provider-specific naming.
 * Adapters (src/connectors/**) translate canonical -> provider payloads; core never does.
 */

import type { CanonicalBill, CanonicalLine, CanonicalDimension } from './model.js';

/** Read a canonical bill out of a stored `proposed_txn` JSONB blob. */
export function billFromStored(txn: Record<string, unknown>): CanonicalBill {
  const t = txn as Record<string, any>;
  const vendor = t.vendorRef ?? {};
  const lines: CanonicalLine[] = (Array.isArray(t.lines) ? t.lines : []).map((l: any) => ({
    description: l.description,
    amount: String(l.Amount ?? l.amount ?? '0'),
    accountId: l.accountRef?.value,
    dimensions: readDimensions(l),
  }));
  return {
    vendorId: vendor.value,
    vendorName: vendor.name,
    docNumber: t.DocNumber != null ? String(t.DocNumber) : undefined,
    txnDate: t.TxnDate,
    dueDate: t.DueDate,
    total: String(t.TotalAmt ?? '0'),
    currency: t.currency,
    memo: t.memo,
    lines,
    dimensions: readDimensions(t),
  };
}

/** Project a canonical bill into the stored `proposed_txn` JSONB shape used by the pipeline. */
export function billToStored(bill: CanonicalBill): Record<string, unknown> {
  return {
    txnType: 'bill',
    vendorRef: bill.vendorId ? { value: bill.vendorId, name: bill.vendorName } : undefined,
    DocNumber: bill.docNumber,
    TxnDate: bill.txnDate,
    DueDate: bill.dueDate,
    TotalAmt: bill.total,
    currency: bill.currency,
    memo: bill.memo,
    lines: bill.lines.map((l) => ({
      Amount: l.amount,
      description: l.description,
      accountRef: l.accountId ? { value: l.accountId } : undefined,
      dimensions: l.dimensions,
    })),
    dimensions: bill.dimensions,
  };
}

function readDimensions(o: any): CanonicalDimension[] | undefined {
  if (!o || !Array.isArray(o.dimensions)) return undefined;
  return o.dimensions.map((d: any) => ({ kind: String(d.kind), id: d.id, name: d.name }));
}
