/**
 * Provider-neutral canonical AP model (CHUNK_5).
 *
 * This module is AP-Hub Core and MUST NOT contain any provider- or OS-specific
 * identifier — enforced by `npm run lint:noleak`. Dimensions are an extensible list
 * (never fixed columns) so a dimension-rich provider does not break the model. Money
 * is carried as a string (NUMERIC read-as-string rule); compare with tolerance.
 */

export type CanonicalEntityKind = 'vendor' | 'account' | 'bill' | 'bill_line' | 'attachment';

/**
 * Resolution/provenance of a dimension. These four states are NEVER collapsed into a
 * single "missing" — a provider that cannot represent a dimension, a dimension we could
 * not map, one the source never provided, and one the source deliberately left blank are
 * materially different and must be surfaced distinctly (F5 accounting-behavior).
 */
export type DimensionState =
  | 'mapped' // resolved to a provider id
  | 'not_provided' // the source document carried no value
  | 'not_mapped' // a value was present but has no configured mapping → hold
  | 'unsupported_by_provider' // the target provider cannot represent this kind → hold
  | 'intentionally_blank'; // the source explicitly left it blank (keep, do not hold)

/** Extensible dimension. `kind` is open (e.g. class | location | department | project | custom:<name>). */
export interface CanonicalDimension {
  kind: string;
  id?: string;
  name?: string;
  /** Provenance — see DimensionState. Optional so pre-F5 records still validate. */
  state?: DimensionState;
  /** The raw extracted value that produced this dimension (audit evidence). */
  raw?: string;
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
