/**
 * Provider-neutral canonical AP model (CHUNK_5).
 *
 * This module is AP-Hub Core and MUST NOT contain any provider- or OS-specific
 * identifier — enforced by `npm run lint:noleak`. Dimensions are an extensible list
 * (never fixed columns) so a dimension-rich provider does not break the model. Money
 * is carried as a string (NUMERIC read-as-string rule); compare with tolerance.
 */

export type CanonicalEntityKind = 'vendor' | 'account' | 'bill' | 'bill_line' | 'attachment';

/** Extensible dimension. `kind` is open (e.g. class | location | department | project | custom:<name>). */
export interface CanonicalDimension {
  kind: string;
  id?: string;
  name?: string;
}

export interface CanonicalLine {
  description?: string;
  amount: string; // NUMERIC as string
  accountId?: string;
  dimensions?: CanonicalDimension[];
}

export interface CanonicalBill {
  vendorId?: string;
  vendorName?: string;
  docNumber?: string;
  txnDate?: string;
  dueDate?: string;
  total: string; // NUMERIC as string
  currency?: string;
  memo?: string;
  lines: CanonicalLine[];
  dimensions?: CanonicalDimension[];
}

export interface CanonicalVendor {
  id?: string;
  name: string;
}

export interface CanonicalAccount {
  id?: string;
  name: string;
  accountType?: string;
}

/** Reference to the record in the external system, using provider-agnostic names. */
export interface ExternalRef {
  provider: string;
  id: string;
  /** Optimistic-concurrency / version token, whatever the provider calls it. */
  revision: string;
  modifiedAt?: string | null;
}

export type CanonicalFieldPath = string;

/**
 * A canonical field a provider cannot represent. It is NEVER silently dropped: the
 * connector returns it, surfaces it to the user, and writes it to the audit log.
 */
export interface Unsupported {
  unsupported: true;
  field: CanonicalFieldPath;
  reason: string;
}

export function isUnsupported(x: unknown): x is Unsupported {
  return typeof x === 'object' && x !== null && (x as { unsupported?: unknown }).unsupported === true;
}

/** Every canonical record preserves the untranslated source and any capability gaps. */
export interface CanonicalRecord<T = unknown> {
  kind: CanonicalEntityKind;
  canonical: T;
  providerRaw?: Record<string, unknown>;
  capabilityGaps?: Unsupported[];
  external?: ExternalRef;
}
