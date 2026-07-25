/**
 * Capability-declaring stub adapters for Xero / Sage Intacct plus the historical
 * QBD contract fixture retained for provider-neutral contract tests.
 *
 * Phase 1A builds NO logic for these providers. Each declares its capability matrix
 * (so the platform can reason about it) but throws `NotImplementedInPhase` on any
 * read/create/readBack/verify/attach. This is what lets the seam exist without
 * pretending the providers work. Active QBD runtime logic lives in `connectors/qbd.ts`;
 * Xero and Sage Intacct remain explicitly out of the supported product surface.
 */

import type { CanonicalEntityKind, CanonicalRecord, Unsupported } from '../canonical/model.js';
import {
  NotImplementedInPhase,
  type AccountingConnector,
  type AttachOk,
  type CapabilityMatrix,
  type CompanyIdentity,
  type ConnectionClass,
  type CreateResult,
  type IdentityResult,
  type PostingTxn,
  type PostedRef,
  type ReadBackResult,
  type ProviderId,
} from './types.js';

function makeStub(provider: ProviderId, connectionClass: ConnectionClass, caps: CapabilityMatrix): AccountingConnector {
  return {
    provider,
    connectionClass,
    companyId: '',
    capabilities: () => caps,
    async verifyCompanyIdentity(_expected: CompanyIdentity): Promise<IdentityResult> {
      throw new NotImplementedInPhase(provider, 'verifyCompanyIdentity');
    },
    async read(_entity: CanonicalEntityKind): Promise<CanonicalRecord[]> {
      throw new NotImplementedInPhase(provider, 'read');
    },
    async create(_entity: CanonicalEntityKind, _record: CanonicalRecord, _idempotencyKey: string): Promise<CreateResult> {
      throw new NotImplementedInPhase(provider, 'create');
    },
    async readBack(_entity: CanonicalEntityKind, _externalId: string): Promise<CanonicalRecord> {
      throw new NotImplementedInPhase(provider, 'readBack');
    },
    async attach(_entity: CanonicalEntityKind, _externalId: string, _doc: Buffer, _filename: string): Promise<AttachOk | Unsupported> {
      throw new NotImplementedInPhase(provider, 'attach');
    },
    async detectExisting(_txn: PostingTxn, _idempotencyKey: string): Promise<PostedRef | null> {
      throw new NotImplementedInPhase(provider, 'detectExisting');
    },
    async postBill(_txn: PostingTxn, _idempotencyKey: string): Promise<PostedRef> {
      throw new NotImplementedInPhase(provider, 'postBill');
    },
    async attachDocument(_externalId: string, _doc: Buffer, _filename: string): Promise<void> {
      throw new NotImplementedInPhase(provider, 'attachDocument');
    },
    async readBackVerify(_txn: PostingTxn, _externalId: string): Promise<ReadBackResult> {
      throw new NotImplementedInPhase(provider, 'readBackVerify');
    },
    close: async () => {},
  };
}

export function createXeroConnector(): AccountingConnector {
  return makeStub('xero', 'cloud', {
    read: ['vendor', 'account', 'bill'],
    write: ['bill'],
    attachments: true,
    purchaseOrders: true,
    itemReceipts: false,
    dimensions: ['tracking_category'], // max 2 active per org (line-level)
    multiCurrency: true,
    multiEntity: false,
    changeFeed: 'webhook',
    idempotency: 'native', // Idempotency-Key header
    unsupported: [],
  });
}

export function createSageIntacctConnector(): AccountingConnector {
  return makeStub('sage_intacct', 'cloud', {
    read: ['vendor', 'account', 'bill'],
    write: ['bill'],
    attachments: true,
    purchaseOrders: true,
    itemReceipts: true,
    dimensions: ['location', 'department', 'class', 'project', 'custom'],
    multiCurrency: true,
    multiEntity: true,
    changeFeed: 'webhook',
    idempotency: 'app_enforced', // controlid/uniqueid, no header
    unsupported: [],
  });
}

export function createQbdConnector(): AccountingConnector {
  return makeStub('qbd', 'local_desktop', {
    read: ['vendor', 'account', 'bill'],
    write: ['bill'],
    attachments: true,
    purchaseOrders: true,
    itemReceipts: false,
    dimensions: ['class', 'customer_job'],
    multiCurrency: false,
    multiEntity: false,
    changeFeed: 'polling', // Web Connector pull
    idempotency: 'app_enforced', // requestID + app dedup ledger
    unsupported: [],
  });
}
