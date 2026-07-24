import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQbdConnector, type QbdExchange } from '../src/connectors/qbd.js';
import { DurableProviderJobs } from '../src/qbdesktop/durable-jobs.js';
import { billQueryRq, parseBillRets } from '../src/qbdesktop/qbxml.js';
import { postOnce } from '../src/pipeline/posting.js';
import { getPool, query } from '../src/db/pool.js';
import { recordProofRef } from '../src/swarmsync/proof.js';
import {
  closeAll, countRows, createConnection, createTenant, insertAttachment,
  insertExtraction, insertMessage, resetTables,
} from './helpers.js';

const billRet = (id = 'TXN-1', edit = 'E1', amount = 100, ref = 'INV-1') =>
  `<QBXML><QBXMLMsgsRs><BillAddRs statusCode="0" statusSeverity="Info" statusMessage="OK"><BillRet>` +
  `<TxnID>${id}</TxnID><EditSequence>${edit}</EditSequence><TxnDate>2026-07-01</TxnDate>` +
  `<RefNumber>${ref}</RefNumber><VendorRef><FullName>Acme</FullName></VendorRef>` +
  `<AmountDue>${amount.toFixed(2)}</AmountDue></BillRet></BillAddRs></QBXMLMsgsRs></QBXML>`;

function simulatedExchange(handler: (qbxml: string, operation: string) => string | Promise<string>): QbdExchange {
  return {
    companyId: 'desktop-company',
    companyName: 'Desktop Test Company',
    execute: vi.fn(async (qbxml, context) => handler(qbxml, context.operation)),
  };
}

async function readyProposal(tenantId: number): Promise<number> {
  const messageId = await insertMessage(tenantId);
  const attachmentId = await insertAttachment(tenantId, messageId, { sha256: `qbd-${tenantId}-${performance.now()}` });
  const extractionId = await insertExtraction(tenantId, messageId, attachmentId, {}, 0.95);
  await recordProofRef({
    tenantId, entityKind: 'extraction', entityId: String(extractionId),
    product: 'verify_api', proofId: 'verify-qbd', chainHash: 'chain-qbd',
  });
  const txn = {
    txnType: 'Bill', vendorRef: { value: 'Acme', name: 'Acme' },
    DocNumber: 'INV-1', TxnDate: '2026-07-01', TotalAmt: 100,
    lines: [{ Amount: 100, description: 'work', accountRef: { value: 'Expense', name: 'Expense' } }],
    tax: 0,
  };
  const { rows } = await query<{ id: number }>(
    `INSERT INTO proposals
       (tenant_id,attachment_id,extraction_id,proposed_txn,idempotency_key,confidence,status,flags)
     VALUES ($1,$2,$3,$4,$5,0.95,'ready','{}') RETURNING id`,
    [tenantId, attachmentId, extractionId, txn, `qbd-key-${tenantId}`],
  );
  await recordProofRef({
    tenantId, entityKind: 'proposal', entityId: String(rows[0]!.id),
    product: 'invoiceproof', proofId: 'invoice-qbd', verdict: 'clean',
  });
  return rows[0]!.id;
}

describe.sequential('CHUNK_2_POSTING_CONTRACT — QBD and shared posting boundary', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('parses BillAdd/query responses and rejects provider errors or malformed identities', () => {
    expect(parseBillRets(billRet())[0]).toMatchObject({
      txnId: 'TXN-1', editSequence: 'E1', refNumber: 'INV-1', amountDue: 100,
    });
    expect(() => parseBillRets(
      '<QBXMLMsgsRs><BillAddRs statusCode="3140" statusSeverity="Error" statusMessage="bad ref"/></QBXMLMsgsRs>',
    )).toThrow('QBD_3140');
    expect(() => parseBillRets(
      '<QBXMLMsgsRs><BillAddRs statusCode="0"><BillRet><TxnID>X</TxnID></BillRet></BillAddRs></QBXMLMsgsRs>',
    )).toThrow('missing TxnID or EditSequence');
    expect(billQueryRq({ refNumber: 'INV-1', vendorName: 'Acme' })).toContain('<BillQueryRq');
  });

  it('runs simulated QBWC happy path through the same proof-gated posting contract', async () => {
    const tenantId = await createTenant('QBD happy');
    await createConnection(tenantId, {
      provider: 'qbd', connectionClass: 'local_desktop', externalCompany: 'desktop-company',
    });
    const proposalId = await readyProposal(tenantId);
    const exchange = simulatedExchange((qbxml, operation) => {
      if (operation === 'query' && qbxml.includes('<RefNumberFilter>')) {
        return '<QBXML><QBXMLMsgsRs><BillQueryRs statusCode="0" statusSeverity="Info" statusMessage="OK"/></QBXMLMsgsRs></QBXML>';
      }
      return billRet();
    });
    const connector = createQbdConnector(exchange);
    const out = await postOnce(tenantId, proposalId, {
      connector,
      anchor: vi.fn().mockResolvedValue({ proof_id: 'a', chain_hash: 'c', verification_status: 'passed', raw: {} }),
      loadPdf: async () => Buffer.from('%PDF'),
      amountCeiling: 10000,
      autoThreshold: 0.9,
      expectedCompanyName: 'Desktop Test Company',
      swarmSyncEnabled: false,
    });
    expect(out.status).toBe('posted');
    expect(exchange.execute).toHaveBeenCalledTimes(3);
    expect(await countRows('postings_ap', "external_id='TXN-1' AND revision='E1'")).toBe(1);
    expect(await countRows('reconciliation', "right_ref='qbd:TXN-1'")).toBe(1);
    expect(await countRows('audit_log', "detail->>'provider'='qbd'")).toBe(1);
  });

  it('adopts a lost BillAdd response after duplicate query and creates exactly once', async () => {
    const tenantId = await createTenant('QBD lost response');
    await createConnection(tenantId, {
      provider: 'qbd', connectionClass: 'local_desktop', externalCompany: 'desktop-company',
    });
    const proposalId = await readyProposal(tenantId);
    let created = false;
    let creates = 0;
    const exchange = simulatedExchange((_qbxml, operation) => {
      if (operation === 'post_bill') {
        creates += 1;
        created = true;
        throw new Error('QBWC response lost after Desktop accepted request');
      }
      if (operation === 'query') {
        return created
          ? billRet('ADOPTED-1', 'E9')
          : '<QBXML><QBXMLMsgsRs><BillQueryRs statusCode="0" statusSeverity="Info" statusMessage="OK"/></QBXMLMsgsRs></QBXML>';
      }
      return billRet('ADOPTED-1', 'E9');
    });
    const out = await postOnce(tenantId, proposalId, {
      connector: createQbdConnector(exchange),
      anchor: vi.fn(), loadPdf: async () => null,
      amountCeiling: 10000, autoThreshold: 0.9, swarmSyncEnabled: false,
    });
    expect(out).toMatchObject({ status: 'posted', qboId: 'ADOPTED-1' });
    expect(creates).toBe(1);
    expect(await countRows('postings_ap', "external_id='ADOPTED-1'")).toBe(1);
  });

  it('durably completes known responses and only adopts held uncertain jobs after query evidence', async () => {
    const tenantId = await createTenant('QBD durable response');
    const connectionId = await createConnection(tenantId, {
      provider: 'qbd', connectionClass: 'local_desktop', externalCompany: 'desktop-company',
    });
    await query(`UPDATE connections SET metadata=$1 WHERE id=$2`, [
      { edition: 'enterprise', platform: 'windows', expectedCompanyId: 'desktop-company' }, connectionId,
    ]);
    const jobs = new DurableProviderJobs(getPool(), 60);
    const known = await jobs.enqueue({
      tenantId, connectionId, operation: 'post_bill', requestPayload: {}, sourceKey: 'known',
    });
    const leased = await jobs.leaseNext({ tenantId, connectionId, observedCompanyId: 'desktop-company' });
    await jobs.markSent(tenantId, known.id, leased!.leaseToken!);
    const complete = await jobs.complete({
      tenantId, jobId: known.id, leaseToken: leased!.leaseToken!,
      responsePayload: { externalId: 'TXN-1', revision: 'E1' },
    });
    expect(complete?.status).toBe('succeeded');

    const uncertain = await jobs.enqueue({
      tenantId, connectionId, operation: 'post_bill', requestPayload: {}, sourceKey: 'uncertain',
    });
    const secondLease = await jobs.leaseNext({ tenantId, connectionId, observedCompanyId: 'desktop-company' });
    await jobs.markSent(tenantId, uncertain.id, secondLease!.leaseToken!);
    await jobs.fail({
      tenantId, jobId: uncertain.id, leaseToken: secondLease!.leaseToken!,
      errorCode: 'TRANSPORT_LOST', errorDetail: 'response unavailable', outcomeKnown: false,
    });
    const adopted = await jobs.adoptUncertain({
      tenantId, jobId: uncertain.id, externalId: 'ADOPTED-2', revision: 'E2',
      providerResponse: { TxnID: 'ADOPTED-2', EditSequence: 'E2' },
    });
    expect(adopted).toMatchObject({
      status: 'succeeded', responsePayload: {
        adopted: true, externalId: 'ADOPTED-2', revision: 'E2',
      },
    });
  });

  it('keeps proof gates fail closed before any QBD exchange', async () => {
    const tenantId = await createTenant('QBD proof gate');
    const proposalId = await readyProposal(tenantId);
    await query(`DELETE FROM proof_refs WHERE tenant_id=$1 AND entity_kind='proposal'`, [tenantId]);
    const exchange = simulatedExchange(() => billRet());
    const out = await postOnce(tenantId, proposalId, {
      connector: createQbdConnector(exchange),
      anchor: vi.fn(), loadPdf: async () => null,
      amountCeiling: 10000, autoThreshold: 0.9, swarmSyncEnabled: false,
    });
    expect(out).toMatchObject({ status: 'held', reason: 'missing_proof_coverage' });
    expect(exchange.execute).not.toHaveBeenCalled();
  });
});
