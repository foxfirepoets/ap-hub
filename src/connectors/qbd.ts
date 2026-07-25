import type { CanonicalEntityKind, CanonicalRecord, Unsupported } from '../canonical/model.js';
import { billAddRq, billQueryRq, parseBillRets, type QbdBillRet } from '../qbdesktop/qbxml.js';
import type {
  AccountingConnector, AttachOk, CapabilityMatrix, CompanyIdentity, CreateResult,
  IdentityResult, PostingTxn, PostedRef, ReadBackResult,
} from './types.js';

export interface QbdExchange {
  companyId: string;
  companyName: string;
  execute(qbxml: string, context: {
    operation: 'query' | 'post_bill' | 'read_back';
    idempotencyKey: string;
  }): Promise<string>;
}

function text(value: unknown): string | undefined {
  return value === undefined || value === null || String(value).trim() === ''
    ? undefined : String(value).trim();
}

export function qbdBillInput(txn: PostingTxn) {
  const row = txn as any;
  if (row.currency) throw new Error('UNSUPPORTED_CAPABILITY: QBD multi-currency bill posting is not certified');
  const dimensions = [
    ...(Array.isArray(row.dimensions) ? row.dimensions : []),
    ...(Array.isArray(row.lines) ? row.lines.flatMap((line: any) => Array.isArray(line.dimensions) ? line.dimensions : []) : []),
  ].filter((dimension: any) => dimension?.state !== 'intentionally_blank');
  if (dimensions.length) throw new Error('UNSUPPORTED_CAPABILITY: QBD bill dimensions are not certified');
  const vendorName = text(row.vendorName ?? row.vendorRef?.name ?? row.vendorRef?.value);
  if (!vendorName) throw new Error('UNSUPPORTED_CAPABILITY: QBD BillAdd requires a vendor FullName');
  const lines = (Array.isArray(row.lines) ? row.lines : []).map((line: any) => {
    const accountFullName = text(line.accountFullName ?? line.accountRef?.name ?? line.accountRef?.value);
    if (!accountFullName) throw new Error('UNSUPPORTED_CAPABILITY: QBD expense line requires an account FullName');
    return {
      accountFullName,
      amount: Number(line.Amount ?? line.amount ?? 0),
      memo: text(line.description ?? line.memo),
    };
  });
  if (!lines.length) throw new Error('UNSUPPORTED_CAPABILITY: QBD BillAdd requires expense lines');
  return {
    vendorName,
    refNumber: text(row.DocNumber),
    txnDate: text(row.TxnDate),
    dueDate: text(row.DueDate),
    memo: text(row.memo),
    lines,
  };
}

function posted(ret: QbdBillRet): PostedRef {
  return { externalId: ret.txnId, revision: ret.editSequence, raw: ret.raw };
}

function readBackMatches(txn: PostingTxn, ret: QbdBillRet): ReadBackResult {
  const expectedAmount = Number((txn as any).TotalAmt ?? 0);
  if (ret.amountDue !== undefined && Math.abs(expectedAmount - ret.amountDue) > 0.01) {
    return { verify: 'mismatch', reason: 'amount', revision: ret.editSequence, raw: ret.raw };
  }
  const expectedRef = text((txn as any).DocNumber);
  if (expectedRef && ret.refNumber && expectedRef !== ret.refNumber) {
    return { verify: 'mismatch', reason: 'docnumber', revision: ret.editSequence, raw: ret.raw };
  }
  return { verify: 'match', revision: ret.editSequence, raw: ret.raw };
}

export function createQbdConnector(exchange: QbdExchange): AccountingConnector {
  const capabilities = (): CapabilityMatrix => ({
    read: [],
    write: ['bill'],
    attachments: false,
    purchaseOrders: false,
    itemReceipts: false,
    dimensions: [],
    multiCurrency: false,
    multiEntity: false,
    changeFeed: 'polling',
    idempotency: 'app_enforced',
    unsupported: ['bill.currency', 'bill.class', 'bill.location'],
  });

  async function queryBill(txn: PostingTxn, idempotencyKey: string): Promise<QbdBillRet | null> {
    const input = qbdBillInput(txn);
    if (!input.refNumber) return null;
    const response = await exchange.execute(billQueryRq({
      vendorName: input.vendorName, refNumber: input.refNumber, txnDate: input.txnDate,
    }, idempotencyKey), { operation: 'query', idempotencyKey });
    return parseBillRets(response)[0] ?? null;
  }

  return {
    provider: 'qbd',
    connectionClass: 'local_desktop',
    companyId: exchange.companyId,
    capabilities,
    async verifyCompanyIdentity(expected: CompanyIdentity): Promise<IdentityResult> {
      return expected.name.trim() === exchange.companyName.trim() ? 'match' : 'mismatch';
    },
    async read(entity: CanonicalEntityKind): Promise<CanonicalRecord[]> {
      if (entity !== 'bill') throw new Error(`QBD read('${entity}') requires a dedicated query adapter`);
      return [];
    },
    async create(entity: CanonicalEntityKind, record: CanonicalRecord, idempotencyKey: string): Promise<CreateResult> {
      if (entity !== 'bill') throw new Error(`QBD create supports 'bill' only, got '${entity}'`);
      const ret = parseBillRets(await exchange.execute(
        billAddRq(qbdBillInput(record.canonical as PostingTxn), idempotencyKey),
        { operation: 'post_bill', idempotencyKey },
      ))[0];
      if (!ret) throw new Error('QBD_MALFORMED: BillAdd response did not contain BillRet');
      return { external: { provider: 'qbd', id: ret.txnId, revision: ret.editSequence }, capabilityGaps: [] };
    },
    async readBack(entity: CanonicalEntityKind, externalId: string): Promise<CanonicalRecord> {
      if (entity !== 'bill') throw new Error(`QBD readBack supports 'bill' only, got '${entity}'`);
      const response = await exchange.execute(billQueryRq({ txnId: externalId }), {
        operation: 'read_back', idempotencyKey: `read:${externalId}`,
      });
      const ret = parseBillRets(response)[0];
      if (!ret) throw new Error(`QBD_NOT_FOUND: bill ${externalId}`);
      return {
        kind: 'bill', canonical: ret.raw, providerRaw: ret.raw,
        external: { provider: 'qbd', id: ret.txnId, revision: ret.editSequence },
      };
    },
    async attach(): Promise<AttachOk | Unsupported> {
      return { unsupported: true, field: 'attachment', reason: 'QBD bill attachment is not certified' };
    },
    async close(): Promise<void> {},
    async detectExisting(txn: PostingTxn, idempotencyKey: string): Promise<PostedRef | null> {
      const ret = await queryBill(txn, idempotencyKey);
      return ret ? posted(ret) : null;
    },
    async postBill(txn: PostingTxn, idempotencyKey: string): Promise<PostedRef> {
      const response = await exchange.execute(billAddRq(qbdBillInput(txn), idempotencyKey), {
        operation: 'post_bill', idempotencyKey,
      });
      const ret = parseBillRets(response)[0];
      if (!ret) throw new Error('QBD_MALFORMED: BillAdd response did not contain BillRet');
      return posted(ret);
    },
    async attachDocument(): Promise<void> {
      throw new Error('UNSUPPORTED_CAPABILITY: QBD bill attachment is not certified');
    },
    async readBackVerify(txn: PostingTxn, externalId: string): Promise<ReadBackResult> {
      const response = await exchange.execute(billQueryRq({ txnId: externalId }), {
        operation: 'read_back', idempotencyKey: `read:${externalId}`,
      });
      const ret = parseBillRets(response)[0];
      if (!ret) throw new Error(`QBD_NOT_FOUND: bill ${externalId}`);
      return readBackMatches(txn, ret);
    },
  };
}
