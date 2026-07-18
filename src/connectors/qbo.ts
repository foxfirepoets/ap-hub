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
} from './types.js';

/** Dimension kinds QBO can represent. Anything else is surfaced as Unsupported. */
const QBO_DIMENSIONS = ['class', 'location'];

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
      read: ['vendor', 'account', 'bill'],
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
      return [];
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
