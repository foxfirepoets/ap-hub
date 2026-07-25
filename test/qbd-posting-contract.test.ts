import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQbdConnector, type QbdExchange } from '../src/connectors/qbd.js';
import { DurableProviderJobs } from '../src/qbdesktop/durable-jobs.js';
import {
  createDurableQbwcTransport, enqueueApprovedQbdBill, MAX_PROVIDER_RESPONSE_BYTES,
  safeProviderResponse,
} from '../src/qbdesktop/production.js';
import { billQueryRq, parseBillRets } from '../src/qbdesktop/qbxml.js';
import { handleQbwcSoapAsync } from '../src/qbdesktop/soap.js';
import { resetSessions } from '../src/qbdesktop/session.js';
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

const soap = (method: string, inner: string) =>
  `<soap:Envelope><soap:Body><${method}>${inner}</${method}></soap:Body></soap:Envelope>`;

async function authenticateObserved(
  auth: Parameters<typeof handleQbwcSoapAsync>[1],
  hooks: Parameters<typeof handleQbwcSoapAsync>[2],
  ticket: string,
  companyId = 'desktop-company',
) {
  const authenticated = await handleQbwcSoapAsync(
    soap('authenticate', '<strUserName>u</strUserName><strPassword>p</strPassword>'), auth, hooks,
  );
  const identityRq = await handleQbwcSoapAsync(
    soap('sendRequestXML', `<ticket>${ticket}</ticket>`), auth, hooks,
  );
  expect(identityRq.body).toContain('CompanyQueryRq');
  const companyRs =
    `<QBXML><QBXMLMsgsRs><CompanyQueryRs statusCode="0" statusSeverity="Info" statusMessage="OK">` +
    `<CompanyRet><CompanyID>${companyId}</CompanyID><CompanyName>${companyId}</CompanyName></CompanyRet>` +
    `</CompanyQueryRs></QBXMLMsgsRs></QBXML>`;
  await handleQbwcSoapAsync(
    soap('receiveResponseXML', `<ticket>${ticket}</ticket><response>${companyRs
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</response><hresult></hresult>`),
    auth, hooks,
  );
  return authenticated;
}

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
    await query(`UPDATE connections SET metadata=metadata || $1 WHERE id=$2`, [
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

  it('production approval boundary enqueues one gated durable QBD posting intent', async () => {
    const tenantId = await createTenant('QBD production queue');
    const connectionId = await createConnection(tenantId, {
      provider: 'qbd', connectionClass: 'local_desktop', externalCompany: 'desktop-company',
    });
    await query('UPDATE connections SET metadata=metadata || $1 WHERE id=$2', [
      { edition: 'enterprise', platform: 'windows', expectedCompanyId: 'desktop-company' },
      connectionId,
    ]);
    const proposalId = await readyProposal(tenantId);
    const jobs = new DurableProviderJobs(getPool(), 60);
    const first = await enqueueApprovedQbdBill(tenantId, proposalId, jobs, {
      enabled: true, writeEnabled: true, companyId: 'desktop-company',
    });
    const second = await enqueueApprovedQbdBill(tenantId, proposalId, jobs, {
      enabled: true, writeEnabled: true, companyId: 'desktop-company',
    });
    expect(second.providerJobId).toBe(first.providerJobId);
    expect(await countRows('provider_jobs', "operation='query' AND status='queued'")).toBe(1);
  });

  it('binds QBWC to the exact tenant/connection when two tenants claim the same company id', async () => {
    resetSessions();
    const tenantA = await createTenant('QBD binding A');
    const tenantB = await createTenant('QBD binding B');
    const connectionA = await createConnection(tenantA, {
      provider: 'qbd', connectionClass: 'local_desktop', externalCompany: 'duplicate-company',
    });
    const connectionB = await createConnection(tenantB, {
      provider: 'qbd', connectionClass: 'local_desktop', externalCompany: 'duplicate-company',
    });
    for (const id of [connectionA, connectionB]) {
      await query('UPDATE connections SET metadata=metadata || $1 WHERE id=$2', [
        { edition: 'enterprise', platform: 'windows', expectedCompanyId: 'duplicate-company' },
        id,
      ]);
    }
    const proposalA = await readyProposal(tenantA);
    const proposalB = await readyProposal(tenantB);
    const jobs = new DurableProviderJobs(getPool(), 60);
    await jobs.enqueue({
      tenantId: tenantA, connectionId: connectionA, proposalId: proposalA, operation: 'post_bill',
      requestPayload: {
        txn: {
          txnType: 'Bill', vendorName: 'A',
          lines: [{ accountFullName: 'Expense', amount: 1 }],
        },
      },
      sourceKey: 'tenant-a',
    });
    await jobs.enqueue({
      tenantId: tenantB, connectionId: connectionB, proposalId: proposalB, operation: 'post_bill',
      requestPayload: {
        txn: {
          txnType: 'Bill', vendorName: 'B',
          lines: [{ accountFullName: 'Expense', amount: 1 }],
        },
      },
      sourceKey: 'tenant-b',
    });
    const hooks = createDurableQbwcTransport({
      QB_DESKTOP_WRITE_ENABLED: true,
      QB_DESKTOP_COMPANY_ID: 'duplicate-company',
      QB_DESKTOP_TENANT_ID: String(tenantA),
      QB_DESKTOP_CONNECTION_ID: String(connectionA),
    }, jobs);
    await authenticateObserved(
      { username: 'u', password: 'p', mode: 'write', makeTicket: () => 'bound-ticket' },
      hooks, 'bound-ticket', 'duplicate-company',
    );
    expect(await countRows('provider_jobs', "tenant_id=$1 AND status='leased'", [tenantA])).toBe(1);
    expect(await countRows('provider_jobs', "tenant_id=$1 AND status='queued'", [tenantB])).toBe(1);
    expect(await countRows('provider_jobs', "tenant_id=$1 AND status='leased'", [tenantB])).toBe(0);
  });

  it('observes the open company through CompanyQuery and holds all work on mismatch', async () => {
    resetSessions();
    const tenantId = await createTenant('QBD wrong open company');
    const connectionId = await createConnection(tenantId, {
      provider: 'qbd', connectionClass: 'local_desktop', externalCompany: 'expected-company',
    });
    await query('UPDATE connections SET metadata=metadata || $1 WHERE id=$2', [
      { expectedCompanyId: 'expected-company' }, connectionId,
    ]);
    const proposalId = await readyProposal(tenantId);
    const jobs = new DurableProviderJobs(getPool(), 60);
    await jobs.enqueue({
      tenantId, connectionId, proposalId, operation: 'query',
      requestPayload: { txn: { vendorName: 'Acme', DocNumber: 'INV-1', TotalAmt: 100,
        lines: [{ accountFullName: 'Expense', amount: 100 }] }, expectedCompanyId: 'expected-company' },
      sourceKey: 'wrong-open-company',
    });
    const auth = { username: 'u', password: 'p', mode: 'write' as const, makeTicket: () => 'wrong-company-ticket' };
    const hooks = createDurableQbwcTransport({
      QB_DESKTOP_WRITE_ENABLED: true, QB_DESKTOP_COMPANY_ID: 'expected-company',
      QB_DESKTOP_TENANT_ID: String(tenantId), QB_DESKTOP_CONNECTION_ID: String(connectionId),
    } as any, jobs);
    await authenticateObserved(auth, hooks, 'wrong-company-ticket', 'actually-open-company');
    const next = await handleQbwcSoapAsync(
      soap('sendRequestXML', '<ticket>wrong-company-ticket</ticket>'), auth, hooks,
    );
    expect(next.body).not.toContain('BillAddRq');
    expect(next.body).not.toContain('BillQueryRq');
    expect(await countRows('provider_jobs',
      "status='held' AND error_code='COMPANY_IDENTITY_MISMATCH'")).toBe(1);
    const observed = (await query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM connections WHERE tenant_id=$1 AND id=$2', [tenantId, connectionId],
    )).rows[0]!.metadata;
    expect(observed).toMatchObject({
      observedCompanyId: 'actually-open-company', companyIdentityStatus: 'mismatch',
    });
    expect(Date.parse(String(observed.lastContactAt))).not.toBeNaN();
  });

  it('requires durable BillQuery read-back and finalizes once across restart/replay', async () => {
    resetSessions();
    const tenantId = await createTenant('QBD durable SOAP');
    const connectionId = await createConnection(tenantId, {
      provider: 'qbd', connectionClass: 'local_desktop', externalCompany: 'desktop-company',
    });
    await query('UPDATE connections SET metadata=metadata || $1 WHERE id=$2', [
      { edition: 'enterprise', platform: 'windows', expectedCompanyId: 'desktop-company' },
      connectionId,
    ]);
    const proposalId = await readyProposal(tenantId);
    const jobs = new DurableProviderJobs(getPool(), 60);
    await enqueueApprovedQbdBill(tenantId, proposalId, jobs, {
      enabled: true, writeEnabled: true, companyId: 'desktop-company',
    });
    const auth = { username: 'u', password: 'p', mode: 'write' as const, makeTicket: () => 'ticket-1' };
    const cfg = {
      QB_DESKTOP_WRITE_ENABLED: true,
      QB_DESKTOP_COMPANY_ID: 'desktop-company',
      QB_DESKTOP_TENANT_ID: String(tenantId),
      QB_DESKTOP_CONNECTION_ID: String(connectionId),
    };
    const hooks = createDurableQbwcTransport(cfg as any, jobs);
    const authenticated = await authenticateObserved(auth, hooks, 'ticket-1');
    expect(authenticated.body).not.toContain('<string>none</string>');
    const preflight = await handleQbwcSoapAsync(
      soap('sendRequestXML', '<ticket>ticket-1</ticket>'), auth, hooks,
    );
    expect(preflight.body).toContain('BillQueryRq');
    const emptyQuery =
      '<QBXML><QBXMLMsgsRs><BillQueryRs statusCode="0" statusSeverity="Info" statusMessage="OK"/></QBXMLMsgsRs></QBXML>';
    await handleQbwcSoapAsync(
      soap('receiveResponseXML', `<ticket>ticket-1</ticket><response>${emptyQuery
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</response><hresult></hresult>`),
      auth, hooks,
    );
    const request = await handleQbwcSoapAsync(
      soap('sendRequestXML', '<ticket>ticket-1</ticket>'), auth, hooks,
    );
    expect((request.body.match(/BillAddRq/g) ?? []).length).toBe(2); // escaped open + close tags
    expect(await countRows('provider_jobs', "status='sent'")).toBe(1);
    await handleQbwcSoapAsync(
      soap('receiveResponseXML',
        `<ticket>ticket-1</ticket><response>${billRet('SOAP-1', 'E7')
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</response><hresult></hresult>`),
      auth, hooks,
    );
    expect(await countRows('provider_jobs', "operation='post_bill' AND status='succeeded'")).toBe(1);
    expect(await countRows('provider_jobs', "operation='read_back' AND status='queued'")).toBe(1);
    expect(await countRows('postings_ap')).toBe(0);
    expect(await countRows('proposals', "id=$1 AND status='ready'", [proposalId])).toBe(1);

    // A process restart between create acknowledgement and verification cannot
    // lose the read-back or turn it into another BillAdd.
    resetSessions();
    const readHooks = createDurableQbwcTransport(cfg as any, new DurableProviderJobs(getPool(), 60));
    const readAuth = { ...auth, makeTicket: () => 'ticket-read' };
    await authenticateObserved(readAuth, readHooks, 'ticket-read');
    const readRequest = await handleQbwcSoapAsync(
      soap('sendRequestXML', '<ticket>ticket-read</ticket>'), readAuth, readHooks,
    );
    expect(readRequest.body).toContain('BillQueryRq');
    expect(readRequest.body).not.toContain('BillAddRq');
    await handleQbwcSoapAsync(
      soap('receiveResponseXML',
        `<ticket>ticket-read</ticket><response>${billRet('SOAP-1', 'E8')
          .replace('BillAddRs', 'BillQueryRs').replace('/BillAddRs', '/BillQueryRs')
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</response><hresult></hresult>`),
      readAuth, readHooks,
    );
    expect(await countRows('provider_jobs', "operation='read_back' AND status='succeeded'")).toBe(1);
    expect(await countRows('postings_ap', "external_id='SOAP-1'")).toBe(1);
    expect(await countRows('reconciliation', "right_ref='qbd:SOAP-1'")).toBe(1);
    expect(await countRows('audit_log', "action='post.qbd'")).toBe(1);
    expect(await countRows('proposals', "id=$1 AND status='posted'", [proposalId])).toBe(1);
    expect(await countRows('proposals', "id=$1 AND status='posted_sandbox'", [proposalId])).toBe(0);

    // Simulated service restart and QBWC replay finds no queued work and cannot emit
    // a second BillAdd or duplicate any finalization row.
    resetSessions();
    const replayHooks = createDurableQbwcTransport(cfg as any, new DurableProviderJobs(getPool(), 60));
    const replayAuth = { ...auth, makeTicket: () => 'ticket-2' };
    const replay = await authenticateObserved(replayAuth, replayHooks, 'ticket-2');
    expect(replay.status).toBe(200);
    const empty = await handleQbwcSoapAsync(
      soap('sendRequestXML', '<ticket>ticket-2</ticket>'), replayAuth, replayHooks,
    );
    expect(empty.body).not.toContain('BillAddRq');
    expect(await countRows('postings_ap', "external_id='SOAP-1'")).toBe(1);
  });

  it('holds an authoritative read-back mismatch and leaves all accounting rows uncommitted', async () => {
    resetSessions();
    const tenantId = await createTenant('QBD mismatch atomicity');
    const connectionId = await createConnection(tenantId, {
      provider: 'qbd', connectionClass: 'local_desktop', externalCompany: 'desktop-company',
    });
    await query('UPDATE connections SET metadata=metadata || $1 WHERE id=$2', [
      { expectedCompanyId: 'desktop-company' }, connectionId,
    ]);
    const proposalId = await readyProposal(tenantId);
    const jobs = new DurableProviderJobs(getPool(), 60);
    await enqueueApprovedQbdBill(tenantId, proposalId, jobs, {
      enabled: true, writeEnabled: true, companyId: 'desktop-company',
    });
    const cfg = {
      QB_DESKTOP_WRITE_ENABLED: true, QB_DESKTOP_COMPANY_ID: 'desktop-company',
      QB_DESKTOP_TENANT_ID: String(tenantId), QB_DESKTOP_CONNECTION_ID: String(connectionId),
    };
    const auth = { username: 'u', password: 'p', mode: 'write' as const, makeTicket: () => 'm-add' };
    const hooks = createDurableQbwcTransport(cfg as any, jobs);
    await authenticateObserved(auth, hooks, 'm-add');
    const preflight = await handleQbwcSoapAsync(soap('sendRequestXML', '<ticket>m-add</ticket>'), auth, hooks);
    expect(preflight.body).toContain('BillQueryRq');
    const emptyQuery =
      '<QBXML><QBXMLMsgsRs><BillQueryRs statusCode="0" statusSeverity="Info" statusMessage="OK"/></QBXMLMsgsRs></QBXML>';
    await handleQbwcSoapAsync(
      soap('receiveResponseXML', `<ticket>m-add</ticket><response>${emptyQuery
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</response><hresult></hresult>`),
      auth, hooks,
    );
    const add = await handleQbwcSoapAsync(soap('sendRequestXML', '<ticket>m-add</ticket>'), auth, hooks);
    expect(add.body).toContain('BillAddRq');
    await handleQbwcSoapAsync(
      soap('receiveResponseXML', `<ticket>m-add</ticket><response>${billRet('M-1', 'E1')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</response><hresult></hresult>`),
      auth, hooks,
    );
    resetSessions();
    const readAuth = { ...auth, makeTicket: () => 'm-read' };
    const readHooks = createDurableQbwcTransport(cfg as any, new DurableProviderJobs(getPool(), 60));
    await authenticateObserved(readAuth, readHooks, 'm-read');
    await handleQbwcSoapAsync(soap('sendRequestXML', '<ticket>m-read</ticket>'), readAuth, readHooks);
    const mismatched = billRet('M-1', 'E2', 999, 'WRONG')
      .replace('BillAddRs', 'BillQueryRs').replace('/BillAddRs', '/BillQueryRs');
    const protocolResponse = await handleQbwcSoapAsync(
      soap('receiveResponseXML', `<ticket>m-read</ticket><response>${mismatched
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</response><hresult></hresult>`),
      readAuth, readHooks,
    );
    expect(protocolResponse.status).toBe(200);
    expect(await countRows('provider_jobs', "operation='read_back' AND status='held' AND error_code='READ_BACK_MISMATCH'")).toBe(1);
    expect(await countRows('postings_ap')).toBe(0);
    expect(await countRows('reconciliation')).toBe(0);
    expect(await countRows('audit_log', "action='post.qbd'")).toBe(0);
    expect(await countRows('proposals', "id=$1 AND status='ready'", [proposalId])).toBe(1);
  });

  it('rolls back every finalization write on a mid-transaction audit failure and retries only BillQuery', async () => {
    resetSessions();
    const tenantId = await createTenant('QBD injected rollback');
    const connectionId = await createConnection(tenantId, {
      provider: 'qbd', connectionClass: 'local_desktop', externalCompany: 'desktop-company',
    });
    await query('UPDATE connections SET metadata=metadata || $1 WHERE id=$2', [{ expectedCompanyId: 'desktop-company' }, connectionId]);
    const proposalId = await readyProposal(tenantId);
    const txn = (await query<{ proposed_txn: Record<string, unknown> }>(
      'SELECT proposed_txn FROM proposals WHERE tenant_id=$1 AND id=$2', [tenantId, proposalId],
    )).rows[0]!.proposed_txn;
    const jobs = new DurableProviderJobs(getPool(), 60);
    const probe = await jobs.enqueue({
      tenantId, connectionId, proposalId, operation: 'query',
      requestPayload: { txn, expectedCompanyId: 'desktop-company' }, sourceKey: 'rollback-probe',
    });
    const probeLease = await jobs.leaseNext({ tenantId, connectionId, observedCompanyId: 'desktop-company' });
    await jobs.markSent(tenantId, probe.id, probeLease!.leaseToken!);
    const create = await jobs.completePreflight({
      tenantId, connectionId, proposalId, jobId: probe.id, leaseToken: probeLease!.leaseToken!,
      txn, expectedCompanyId: 'desktop-company', providerResponse: { ok: true },
    });
    const createLease = await jobs.leaseNext({ tenantId, connectionId, observedCompanyId: 'desktop-company' });
    await jobs.markSent(tenantId, create.id, createLease!.leaseToken!);
    await jobs.acknowledgeCreateAndQueueReadBack({
      tenantId, connectionId, proposalId, jobId: create.id, leaseToken: createLease!.leaseToken!,
      externalId: 'ROLLBACK-1', revision: 'E1', providerResponse: { ok: true },
      txn, expectedCompanyId: 'desktop-company',
    });
    await query(`CREATE OR REPLACE FUNCTION aphub_test_fail_qbd_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='post.qbd' THEN RAISE EXCEPTION 'injected qbd audit failure'; END IF; RETURN NEW; END $$`);
    await query(`CREATE TRIGGER aphub_test_fail_qbd_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION aphub_test_fail_qbd_audit()`);
    try {
      const cfg = {
        QB_DESKTOP_WRITE_ENABLED: true, QB_DESKTOP_COMPANY_ID: 'desktop-company',
        QB_DESKTOP_TENANT_ID: String(tenantId), QB_DESKTOP_CONNECTION_ID: String(connectionId),
      };
      const auth = { username: 'u', password: 'p', mode: 'write' as const, makeTicket: () => 'rollback-read' };
      const hooks = createDurableQbwcTransport(cfg as any, jobs);
      await authenticateObserved(auth, hooks, 'rollback-read');
      const rq = await handleQbwcSoapAsync(soap('sendRequestXML', '<ticket>rollback-read</ticket>'), auth, hooks);
      expect(rq.body).toContain('BillQueryRq');
      const read = billRet('ROLLBACK-1', 'E2').replace('BillAddRs', 'BillQueryRs').replace('/BillAddRs', '/BillQueryRs');
      expect((await handleQbwcSoapAsync(
        soap('receiveResponseXML', `<ticket>rollback-read</ticket><response>${read
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</response><hresult></hresult>`),
        auth, hooks,
      )).status).toBe(200);
    } finally {
      await query('DROP TRIGGER IF EXISTS aphub_test_fail_qbd_audit ON audit_log');
      await query('DROP FUNCTION IF EXISTS aphub_test_fail_qbd_audit()');
    }
    expect(await countRows('postings_ap')).toBe(0);
    expect(await countRows('reconciliation')).toBe(0);
    expect(await countRows('audit_log', "action='post.qbd'")).toBe(0);
    expect(await countRows('proposals', "id=$1 AND status='ready'", [proposalId])).toBe(1);
    expect(await countRows('provider_jobs',
      "operation='read_back' AND status='failed' AND error_code='READ_QUERY_INFRASTRUCTURE'")).toBe(1);
    const readJob = (await jobs.list(tenantId)).find((job) => job.operation === 'read_back')!;
    await jobs.retry(tenantId, readJob.id);
    resetSessions();
    const retryAuth = { username: 'u', password: 'p', mode: 'write' as const, makeTicket: () => 'rollback-retry' };
    const retryHooks = createDurableQbwcTransport({
      QB_DESKTOP_WRITE_ENABLED: true, QB_DESKTOP_COMPANY_ID: 'desktop-company',
      QB_DESKTOP_TENANT_ID: String(tenantId), QB_DESKTOP_CONNECTION_ID: String(connectionId),
    } as any, jobs);
    await authenticateObserved(retryAuth, retryHooks, 'rollback-retry');
    const retryRq = await handleQbwcSoapAsync(
      soap('sendRequestXML', '<ticket>rollback-retry</ticket>'), retryAuth, retryHooks,
    );
    expect(retryRq.body).toContain('BillQueryRq');
    expect(retryRq.body).not.toContain('BillAddRq');
  });

  it('resolves an expired sent create by BillQuery adoption without replaying BillAdd', async () => {
    resetSessions();
    const tenantId = await createTenant('QBD uncertain resolver');
    const connectionId = await createConnection(tenantId, {
      provider: 'qbd', connectionClass: 'local_desktop', externalCompany: 'desktop-company',
    });
    await query('UPDATE connections SET metadata=metadata || $1 WHERE id=$2', [{ expectedCompanyId: 'desktop-company' }, connectionId]);
    const proposalId = await readyProposal(tenantId);
    const jobs = new DurableProviderJobs(getPool(), 1);
    await enqueueApprovedQbdBill(tenantId, proposalId, jobs, {
      enabled: true, writeEnabled: true, companyId: 'desktop-company',
    });
    const preflight = await jobs.leaseNext({ tenantId, connectionId, observedCompanyId: 'desktop-company' });
    await jobs.markSent(tenantId, preflight!.id, preflight!.leaseToken!);
    const create = await jobs.completePreflight({
      tenantId, connectionId, proposalId, jobId: preflight!.id, leaseToken: preflight!.leaseToken!,
      txn: preflight!.requestPayload.txn as Record<string, unknown>,
      expectedCompanyId: 'desktop-company', providerResponse: { ok: true },
    });
    const leased = await jobs.leaseNext({ tenantId, connectionId, observedCompanyId: 'desktop-company' });
    expect(leased?.id).toBe(create.id);
    await jobs.markSent(tenantId, leased!.id, leased!.leaseToken!);
    await query(`UPDATE provider_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [leased!.id]);
    resetSessions();
    const auth = { username: 'u', password: 'p', mode: 'write' as const, makeTicket: () => 'adopt-read' };
    const hooks = createDurableQbwcTransport({
      QB_DESKTOP_WRITE_ENABLED: true, QB_DESKTOP_COMPANY_ID: 'desktop-company',
      QB_DESKTOP_TENANT_ID: String(tenantId), QB_DESKTOP_CONNECTION_ID: String(connectionId),
    } as any, new DurableProviderJobs(getPool(), 60));
    await authenticateObserved(auth, hooks, 'adopt-read');
    const resolverRequest = await handleQbwcSoapAsync(
      soap('sendRequestXML', '<ticket>adopt-read</ticket>'), auth, hooks,
    );
    expect(resolverRequest.body).toContain('BillQueryRq');
    expect(resolverRequest.body).not.toContain('BillAddRq');
    const adoptedRet = billRet('ADOPT-QBWC', 'E10')
      .replace('BillAddRs', 'BillQueryRs').replace('/BillAddRs', '/BillQueryRs');
    await handleQbwcSoapAsync(
      soap('receiveResponseXML', `<ticket>adopt-read</ticket><response>${adoptedRet
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</response><hresult></hresult>`),
      auth, hooks,
    );
    expect((await jobs.list(tenantId)).filter((job) => job.operation === 'post_bill')).toHaveLength(1);
    expect(await countRows('provider_jobs', "operation='post_bill' AND status='succeeded'")).toBe(1);
    expect(await countRows('postings_ap', "external_id='ADOPT-QBWC'")).toBe(1);
    expect(await countRows('proposals', "id=$1 AND status='posted'", [proposalId])).toBe(1);
  });

  it('allowlists and bounds persisted provider responses without raw secrets', () => {
    const xml = billRet('SAFE-1', 'E1').replace(
      '</BillRet>', `<CreditCardNumber>4111111111111111</CreditCardNumber>` +
      `<AccessToken>${'secret'.repeat(20_000)}</AccessToken></BillRet>`,
    );
    const safe = safeProviderResponse(xml);
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain('4111111111111111');
    expect(serialized).not.toContain('AccessToken');
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(MAX_PROVIDER_RESPONSE_BYTES);
    expect(safe).toMatchObject({ ok: true, externalId: 'SAFE-1', revision: 'E1' });
    const rejected = safeProviderResponse(
      `<QBXMLMsgsRs><BillAddRs statusCode="3140" statusSeverity="Error" ` +
      `statusMessage="${'bounded '.repeat(500)} token=super-secret"/></QBXMLMsgsRs>`,
    );
    const rejectedJson = JSON.stringify(rejected);
    expect(rejectedJson).not.toContain('super-secret');
    expect(rejectedJson.length).toBeLessThan(2_000);
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
