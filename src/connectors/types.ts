/**
 * Provider-neutral AccountingConnector contract (CHUNK_5). Every provider adapter
 * (QBO reference impl + QBD/Xero/Sage stubs) implements this interface; the connector
 * contract-test suite (test/connector-contract.test.ts) is what "supported" means.
 *
 * Provider-specific naming is permitted here and under src/connectors/** ONLY. Core
 * (everything else) stays provider-neutral — enforced by `npm run lint:noleak`.
 */

import type {
  CanonicalEntityKind,
  CanonicalRecord,
  CanonicalFieldPath,
  Unsupported,
  ExternalRef,
} from '../canonical/model.js';

export type ProviderId = 'qbo' | 'qbd' | 'xero' | 'sage_intacct';
export type ConnectionClass = 'cloud' | 'local_desktop';

/** Thrown by capability-declaring stub adapters that are not built in Phase 1A. */
export class NotImplementedInPhase extends Error {
  constructor(provider: ProviderId, op: string) {
    super(`${provider}.${op} is not implemented in Phase 1A — capability-declaring stub only.`);
    this.name = 'NotImplementedInPhase';
  }
}

export interface CapabilityMatrix {
  read: CanonicalEntityKind[];
  write: CanonicalEntityKind[];
  attachments: boolean;
  purchaseOrders: boolean;
  itemReceipts: boolean;
  /** Dimension kinds this provider can represent (extensible list, not fixed columns). */
  dimensions: string[];
  multiCurrency: boolean;
  multiEntity: boolean;
  changeFeed: 'webhook' | 'polling';
  idempotency: 'native' | 'app_enforced';
  /** Canonical field paths this provider explicitly cannot represent. */
  unsupported: CanonicalFieldPath[];
}

export interface CompanyIdentity {
  name: string;
}
export type IdentityResult = 'match' | 'mismatch';

export interface CreateResult {
  external: ExternalRef;
  /** Fields the provider could not represent — surfaced + audited, never dropped. */
  capabilityGaps: Unsupported[];
}

export interface AttachOk {
  attached: true;
  id?: string;
}

/**
 * The live posting path's transaction, passed opaquely to the adapter which owns ALL
 * provider translation (payload build, dedup query, read-back verification). The core
 * pipeline never constructs a provider payload and never imports a provider write module.
 */
export type PostingTxn = Record<string, unknown>;

/** A reference to a record that exists in the provider (created or a duplicate hit). */
export interface PostedRef {
  externalId: string;
  revision: string;
  raw: Record<string, unknown>;
}

/** Authoritative read-back verdict — the adapter compares approved vs actual, neutrally. */
export type ReadBackResult =
  | { verify: 'match'; revision: string; raw: Record<string, unknown> }
  | { verify: 'mismatch'; reason: 'amount' | 'docnumber' | 'dimension'; detail?: unknown; revision: string; raw: Record<string, unknown> };

export interface AccountingConnector {
  readonly provider: ProviderId;
  readonly connectionClass: ConnectionClass;
  /** Provider company/realm identifier (for audit + reconciliation), never a raw writer. */
  readonly companyId: string;

  capabilities(): CapabilityMatrix;

  /** Guard: must return 'match' before any create is permitted. */
  verifyCompanyIdentity(expected: CompanyIdentity): Promise<IdentityResult>;

  read(entity: CanonicalEntityKind, where?: Record<string, unknown>): Promise<CanonicalRecord[]>;

  create(entity: CanonicalEntityKind, record: CanonicalRecord, idempotencyKey: string): Promise<CreateResult>;

  /** Authoritative post-write read: confirms externalId + revision. */
  readBack(entity: CanonicalEntityKind, externalId: string): Promise<CanonicalRecord>;

  attach(entity: CanonicalEntityKind, externalId: string, doc: Buffer, filename: string): Promise<AttachOk | Unsupported>;

  close(): Promise<void>;

  // --- Live posting operations (F4): the ONLY authorized live accounting path. The
  // adapter translates the opaque PostingTxn to the provider; the pipeline stays neutral.

  /** Duplicate-existence probe (Layer-2 dedup). THROWS on an unknown/unavailable result
   *  so the pipeline fails closed; returns null when definitively absent. */
  detectExisting(txn: PostingTxn, idempotencyKey: string): Promise<PostedRef | null>;

  /** Create the accounting document (Bill). The adapter builds the provider payload. */
  postBill(txn: PostingTxn, idempotencyKey: string): Promise<PostedRef>;

  /** Attach a source document to a created record (best-effort; provider-specific). */
  attachDocument(externalId: string, doc: Buffer, filename: string): Promise<void>;

  /** Authoritative read-back + neutral verify of the approved transaction vs what posted. */
  readBackVerify(txn: PostingTxn, externalId: string): Promise<ReadBackResult>;
}
