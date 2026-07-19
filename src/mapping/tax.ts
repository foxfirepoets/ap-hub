/**
 * Tax handling (F5 accounting-behavior). Provider-neutral and pure. Tax is only ever
 * written when it (a) has an explicitly-configured provider tax code AND (b) reconciles
 * to the invoice total within a currency tolerance. Otherwise the invoice is HELD with a
 * NAMED reason (tax_unmapped / tax_unreconciled) BEFORE any create — never guessed, never
 * silently converted between tax-inclusive and tax-exclusive, never dropped.
 */

export type TaxMode = 'exclusive' | 'inclusive';

export interface CanonicalTaxLine {
  amount: number;
  code?: string | null;
}

/** Structured tax carried on a proposed txn. A bare number is treated as legacy amount. */
export interface CanonicalTax {
  mode: TaxMode;
  /** Total tax amount. */
  amount: number;
  /** Resolved provider tax-code id. Absent ⇒ unmapped ⇒ hold (never guess). */
  code?: string | null;
  codeName?: string | null;
  lines?: CanonicalTaxLine[];
  /** Net subtotal (sum of line nets) when known — used for reconciliation. */
  subtotal?: number | null;
  /** Raw extracted tax evidence, preserved for the audit/exception detail. */
  evidence?: unknown;
}

export type TaxDecision =
  | { kind: 'none' }
  | { kind: 'ok'; tax: CanonicalTax; reconciliation: TaxReconciliation }
  | { kind: 'hold'; reason: 'tax_unmapped' | 'tax_unreconciled'; detail: string; evidence: unknown };

export interface TaxReconciliation {
  mode: TaxMode;
  taxAmount: number;
  lineSum: number;
  total: number;
  code: string;
  ok: boolean;
}

const DEFAULT_TOL = 0.01;

function num(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/** Read a structured tax object from an arbitrary proposed_txn.tax value (number|obj|null). */
export function normalizeTax(raw: unknown): number | CanonicalTax | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'object') return raw as CanonicalTax;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Decide how to treat the tax on a proposed txn.
 * - no tax (0/absent) → none (posts without a tax line)
 * - tax amount present but NO structured code → tax_unmapped
 * - structured tax without a resolved code → tax_unmapped
 * - structured tax that does not reconcile to the total → tax_unreconciled
 * - structured tax with code AND reconciling → ok (add a tax line)
 */
export function evaluateTax(txn: any, tol: number = DEFAULT_TOL): TaxDecision {
  const raw = normalizeTax(txn?.tax);
  if (raw === undefined) return { kind: 'none' };

  const lineSum = Array.isArray(txn?.lines)
    ? txn.lines.reduce((a: number, l: any) => a + num(l?.Amount ?? l?.amount), 0)
    : 0;
  const total = num(txn?.TotalAmt);

  // Legacy / bare-number tax: an amount with no configured code cannot be handled.
  if (typeof raw === 'number') {
    if (Math.abs(raw) < tol) return { kind: 'none' };
    return {
      kind: 'hold',
      reason: 'tax_unmapped',
      detail: `tax amount ${raw} present with no configured provider tax code`,
      evidence: { taxAmount: raw, lineSum, total },
    };
  }

  const tax = raw;
  const taxAmount = num(tax.amount);
  if (Math.abs(taxAmount) < tol) return { kind: 'none' };

  const evidence = { mode: tax.mode, taxAmount, lineSum, total, code: tax.code ?? null, raw: tax.evidence };

  // Never guess a code.
  if (!tax.code) {
    return { kind: 'hold', reason: 'tax_unmapped', detail: 'tax present without a configured tax code', evidence };
  }

  // Reconcile. Inclusive and exclusive are NEVER silently interconverted: each has its
  // own equality and a value that only fits the other mode is a non-reconciliation.
  const subtotal = tax.subtotal != null ? num(tax.subtotal) : lineSum;
  let ok: boolean;
  if (tax.mode === 'inclusive') {
    // Line amounts are gross (include tax): they already sum to the total, and the tax
    // is a component strictly inside it.
    ok = Math.abs(subtotal - total) <= tol && taxAmount > 0 && taxAmount < total + tol;
  } else {
    // Exclusive: net lines + tax = total.
    ok = Math.abs(subtotal + taxAmount - total) <= tol;
  }

  if (!ok) {
    return {
      kind: 'hold',
      reason: 'tax_unreconciled',
      detail: `tax does not reconcile (mode=${tax.mode}, subtotal=${subtotal}, tax=${taxAmount}, total=${total})`,
      evidence,
    };
  }

  return {
    kind: 'ok',
    tax: { ...tax, amount: taxAmount, subtotal },
    reconciliation: { mode: tax.mode, taxAmount, lineSum: subtotal, total, code: String(tax.code), ok: true },
  };
}
