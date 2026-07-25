import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { writeAudit, hashOf } from '../audit.js';
import { ownerGateEnabled } from '../accounting/write-gates.js';
import { hasProofRef } from '../swarmsync/proof.js';
import { DurableProviderJobs } from './durable-jobs.js';
import {
  billAddRq, billQueryRq, companyQueryRq, parseBillRets, parseCompanyIdentity,
  parseQbxmlResponse, type QbdBillRet,
} from './qbxml.js';
import { qbdBillInput } from '../connectors/qbd.js';
import type { Config } from '../config.js';
import type { QbwcAsyncHooks } from './soap.js';
import { getSession } from './session.js';

export const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;

function boundedText(value: unknown, max = 1024): string {
  return [...String(value ?? '')]
    .map((char) => (char.charCodeAt(0) < 32 ? ' ' : char))
    .join('')
    .replace(/(token|secret|password|authorization|card(?:number)?)\s*[=:]\s*[^\s"'<>]+/gi, '$1=[REDACTED]')
    .slice(0, max);
}

/** Persist only accounting identifiers/statuses; never raw provider XML. */
export function safeProviderResponse(xml: string): Record<string, unknown> {
  const parsed = parseQbxmlResponse(xml);
  const bill = parsed.ok ? parseBillRets(xml)[0] : undefined;
  const value: Record<string, unknown> = {
    ok: parsed.ok,
    statuses: parsed.statuses.slice(0, 20).map((row) => ({
      requestID: boundedText(row.requestID, 128),
      statusCode: boundedText(row.statusCode, 32),
      statusSeverity: boundedText(row.statusSeverity, 32),
      statusMessage: boundedText(row.statusMessage, 1024),
    })),
    ...(bill ? {
      externalId: boundedText(bill.txnId, 256),
      revision: boundedText(bill.editSequence, 256),
      refNumber: boundedText(bill.refNumber, 256),
      amountDue: bill.amountDue,
    } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
  }
  return value;
}

function expectedMoney(txn: Record<string, unknown>): number {
  const explicit = Number((txn as any).TotalAmt);
  if (Number.isFinite(explicit)) return explicit;
  return (Array.isArray((txn as any).lines) ? (txn as any).lines : [])
    .reduce((sum: number, line: any) => sum + Number(line.Amount ?? line.amount ?? 0), 0);
}

function billMismatch(
  ret: QbdBillRet,
  expected: { externalId?: string; txn: Record<string, unknown> },
): string | null {
  if (expected.externalId && ret.txnId !== expected.externalId) return 'external_identity';
  const amount = expectedMoney(expected.txn);
  if (ret.amountDue === undefined || !Number.isFinite(ret.amountDue) || Math.abs(ret.amountDue - amount) > 0.01) {
    return 'amount';
  }
  const ref = String((expected.txn as any).DocNumber ?? '').trim();
  if (ref && ret.refNumber !== ref) return 'doc_number';
  return null;
}

async function finalizeQbdReadBack(input: {
  tenantId: number; connectionId: number; proposalId: number; companyId: string;
  jobId: number; leaseToken: string; ret: QbdBillRet; response: Record<string, unknown>;
}): Promise<number> {
  return withTransaction(async (client) => {
    const job = (await client.query<{
      id: string; status: string; lease_token: string | null; request_payload: Record<string, any>;
    }>(
      `SELECT id,status,lease_token,request_payload FROM provider_jobs
        WHERE tenant_id=$1 AND connection_id=$2 AND id=$3 AND proposal_id=$4
          AND operation='read_back' FOR UPDATE`,
      [input.tenantId, input.connectionId, input.jobId, input.proposalId],
    )).rows[0];
    if (!job || job.status !== 'sent' || job.lease_token !== input.leaseToken) {
      throw new Error('STALE_READ_BACK_LEASE');
    }
    const expectedCompany = String(job.request_payload.expectedCompanyId ?? '');
    if (!expectedCompany || expectedCompany !== input.companyId) throw new Error('COMPANY_IDENTITY_MISMATCH');
    const mismatch = billMismatch(input.ret, {
      externalId: job.request_payload.externalId
        ? String(job.request_payload.externalId)
        : undefined,
      txn: job.request_payload.txn ?? {},
    });
    if (mismatch) {
      await client.query(
        `UPDATE provider_jobs SET status='held',response_payload=$4,
           error_code='READ_BACK_MISMATCH',error_detail=$5,
           lease_token=NULL,leased_at=NULL,lease_expires_at=NULL,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND lease_token=$3`,
        [input.tenantId, input.jobId, input.leaseToken, input.response, mismatch],
      );
      return 0;
    }
    const parentJobId = Number(job.request_payload.parentJobId);
    const parent = (await client.query<{
      id: string; status: string; error_code: string | null; operation: string;
    }>(
      `SELECT id,status,error_code,operation FROM provider_jobs
        WHERE tenant_id=$1 AND connection_id=$2 AND id=$3 AND proposal_id=$4
          AND operation IN ('post_bill','query') FOR UPDATE`,
      [input.tenantId, input.connectionId, parentJobId, input.proposalId],
    )).rows[0];
    const isAdoption = job.request_payload.resolution === 'uncertain_duplicate_probe';
    const isPreexisting = job.request_payload.resolution === 'preexisting_adoption';
    if (!parent || (isAdoption
      ? !(parent.operation === 'post_bill' && parent.status === 'held' && parent.error_code === 'UNCERTAIN_OUTCOME')
      : !(parent.status === 'succeeded' &&
          (parent.operation === 'post_bill' || (isPreexisting && parent.operation === 'query'))))) {
      throw new Error('PARENT_JOB_CONFLICT');
    }
    const proposal = (await client.query<{
    attachment_id: number | null; idempotency_key: string; proposed_txn: Record<string, unknown>;
    status: string;
  }>(
    `SELECT attachment_id,idempotency_key,proposed_txn,status FROM proposals
      WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
    [input.tenantId, input.proposalId],
  )).rows[0];
  if (!proposal) throw new Error('PROPOSAL_NOT_FOUND');
    if (proposal.status !== 'ready') throw new Error('PROPOSAL_STATE_CONFLICT');
    const posting = await client.query<{ id: number }>(
    `INSERT INTO postings_ap
      (tenant_id,attachment_id,proposal_id,entity_type,external_id,revision,realm,mode,
       idempotency_key,status,request,response,posted_at)
     VALUES ($1,$2,$3,'Bill',$4,$5,$6,'production',$7,'posted',$8,$9,now())
     ON CONFLICT (tenant_id,idempotency_key) DO UPDATE
       SET external_id=EXCLUDED.external_id,revision=EXCLUDED.revision,response=EXCLUDED.response
       WHERE postings_ap.proposal_id=EXCLUDED.proposal_id
         AND postings_ap.external_id=EXCLUDED.external_id
     RETURNING id`,
    [input.tenantId, proposal.attachment_id, input.proposalId, input.ret.txnId,
      input.ret.editSequence, input.companyId, proposal.idempotency_key,
      proposal.proposed_txn, input.response],
  );
    if (!posting.rows[0]) throw new Error('POSTING_IDENTITY_CONFLICT');
  const postingId = posting.rows[0]!.id;
    await client.query(`UPDATE proposals SET status='posted' WHERE tenant_id=$1 AND id=$2`, [
    input.tenantId, input.proposalId,
  ]);
    await client.query(
    `INSERT INTO reconciliation (tenant_id,kind,left_ref,right_ref,match_status,variance)
     SELECT $1,'proposal_vs_created',$2,$3,'matched',$4
      WHERE NOT EXISTS (
        SELECT 1 FROM reconciliation WHERE tenant_id=$1 AND left_ref=$2 AND right_ref=$3
      )`,
    [input.tenantId, `proposal:${input.proposalId}`, `qbd:${input.ret.txnId}`,
      JSON.stringify({ diffHash: hashOf(input.response) })],
  );
    const priorAudit = await client.query(
    `SELECT 1 FROM audit_log WHERE tenant_id=$1 AND action='post.qbd'
      AND entity=$2 LIMIT 1`, [input.tenantId, `posting:${postingId}`],
  );
  if (!priorAudit.rowCount) {
      await writeAudit({
      tenantId: input.tenantId, action: 'post.qbd', entity: `posting:${postingId}`,
      realm: input.companyId, afterHash: hashOf(input.response),
        detail: { provider: 'qbd', externalId: input.ret.txnId, adopted: isAdoption || isPreexisting },
      }, client);
  }
    await client.query(
      `UPDATE provider_jobs SET status='succeeded',response_payload=$4,
         error_code=NULL,error_detail=NULL,lease_token=NULL,leased_at=NULL,
         lease_expires_at=NULL,updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND status='sent' AND lease_token=$3`,
      [input.tenantId, input.jobId, input.leaseToken, input.response],
    );
    if (isAdoption) {
      await client.query(
        `UPDATE provider_jobs SET status='succeeded',
           response_payload=response_payload || $3::jsonb,error_code=NULL,
           error_detail='adopted after authoritative duplicate query',updated_at=now()
         WHERE tenant_id=$1 AND id=$2 AND status='held' AND error_code='UNCERTAIN_OUTCOME'`,
        [input.tenantId, parentJobId, JSON.stringify({
          adopted: true, externalId: input.ret.txnId, revision: input.ret.editSequence,
        })],
      );
    }
    return postingId;
  });
}

type ActiveLease = {
  tenantId: number; connectionId: number; jobId: number; proposalId: number;
  operation: 'query' | 'post_bill' | 'read_back'; requestPayload: Record<string, any>;
  leaseToken: string; qbxml: string; companyId: string; sent: boolean;
};

async function enqueueLeasedWork(
  ticket: string,
  observedCompanyId: string,
  connection: { id: number; tenant_id: number },
  jobs: DurableProviderJobs,
  leases: Map<string, ActiveLease>,
): Promise<void> {
  const job = await jobs.leaseNext({
    tenantId: connection.tenant_id, connectionId: connection.id, observedCompanyId,
  });
  if (!job || !['query', 'post_bill', 'read_back'].includes(job.operation) || !job.proposalId || !job.leaseToken) return;
  const txn = job.requestPayload.txn as any;
  const qbxml = job.operation === 'post_bill'
    ? billAddRq(qbdBillInput(txn), job.idempotencyKey)
    : billQueryRq(job.requestPayload.externalId
      ? { txnId: String(job.requestPayload.externalId) }
      : {
          vendorName: qbdBillInput(txn).vendorName,
          refNumber: qbdBillInput(txn).refNumber,
          txnDate: qbdBillInput(txn).txnDate,
        }, job.idempotencyKey);
  getSession(ticket)?.enqueue(`provider-job:${job.id}`, qbxml);
  leases.set(ticket, {
    tenantId: job.tenantId, connectionId: job.connectionId, jobId: job.id,
    proposalId: job.proposalId, leaseToken: job.leaseToken, qbxml,
    operation: job.operation as 'query' | 'post_bill' | 'read_back',
    requestPayload: job.requestPayload, companyId: observedCompanyId, sent: false,
  });
}

export function createDurableQbwcTransport(
  cfg: Pick<
    Config,
    | 'QB_DESKTOP_WRITE_ENABLED'
    | 'QB_DESKTOP_COMPANY_ID'
    | 'QB_DESKTOP_TENANT_ID'
    | 'QB_DESKTOP_CONNECTION_ID'
  >,
  jobs = new DurableProviderJobs(),
): QbwcAsyncHooks {
  const leases = new Map<string, ActiveLease>();
  const pendingCompany = new Map<string, { id: number; tenant_id: number }>();
  return {
    async authenticated(ticket) {
      if (
        !cfg.QB_DESKTOP_WRITE_ENABLED ||
        !cfg.QB_DESKTOP_COMPANY_ID ||
        !cfg.QB_DESKTOP_TENANT_ID ||
        !cfg.QB_DESKTOP_CONNECTION_ID
      ) return;
      const connection = (await query<{ id: number; tenant_id: number; metadata: Record<string, unknown> }>(
        `SELECT id,tenant_id,metadata FROM connections
          WHERE tenant_id=$1 AND id=$2
            AND provider='qbd' AND connection_class='local_desktop' AND status='active'
            AND COALESCE(metadata->>'expectedCompanyId',external_company)=$3
          LIMIT 1`,
        [
          Number(cfg.QB_DESKTOP_TENANT_ID),
          Number(cfg.QB_DESKTOP_CONNECTION_ID),
          cfg.QB_DESKTOP_COMPANY_ID,
        ],
      )).rows[0];
      if (!connection) return;
      pendingCompany.set(ticket, connection);
      getSession(ticket)?.enqueue('company-identity', companyQueryRq(`company:${connection.id}`));
    },
    async requestSent(ticket, qbxml) {
      const lease = leases.get(ticket);
      if (!lease || lease.qbxml !== qbxml) return pendingCompany.has(ticket);
      const marked = await jobs.markSent(lease.tenantId, lease.jobId, lease.leaseToken);
      lease.sent = marked;
      return marked;
    },
    async responseReceived(ticket, response, hresult) {
      const company = pendingCompany.get(ticket);
      if (company && !leases.has(ticket)) {
        if (hresult) {
          pendingCompany.delete(ticket);
          return;
        }
        const observed = parseCompanyIdentity(response);
        pendingCompany.delete(ticket);
        await query(
          `UPDATE connections
              SET metadata=COALESCE(metadata,'{}'::jsonb) || $3::jsonb, updated_at=now()
            WHERE tenant_id=$1 AND id=$2 AND provider='qbd' AND connection_class='local_desktop'`,
          [company.tenant_id, company.id, JSON.stringify({
            observedCompanyId: boundedText(observed, 256),
            lastContactAt: new Date().toISOString(),
            companyIdentityStatus: observed === cfg.QB_DESKTOP_COMPANY_ID ? 'matched' : 'mismatch',
          })],
        );
        if (observed !== cfg.QB_DESKTOP_COMPANY_ID) {
          await jobs.leaseNext({
            tenantId: company.tenant_id, connectionId: company.id, observedCompanyId: observed,
          });
          return;
        }
        const refreshed = (await query<{ metadata: Record<string, unknown> }>(
          'SELECT metadata FROM connections WHERE tenant_id=$1 AND id=$2',
          [company.tenant_id, company.id],
        )).rows[0];
        if (!refreshed || !ownerGateEnabled(refreshed.metadata, observed)) return;
        await enqueueLeasedWork(ticket, observed, company, jobs, leases);
        return;
      }
      const lease = leases.get(ticket);
      if (!lease?.sent) return;
      if (hresult) {
        await jobs.fail({
          tenantId: lease.tenantId, jobId: lease.jobId, leaseToken: lease.leaseToken,
          errorCode: 'QBWC_TRANSPORT_ERROR', errorDetail: boundedText(hresult), outcomeKnown: false,
        });
        leases.delete(ticket);
        return;
      }
      try {
        const safe = safeProviderResponse(response);
        if (safe.ok !== true) {
          const status = (safe.statuses as Array<Record<string, unknown>>)[0];
          await jobs.fail({
            tenantId: lease.tenantId, jobId: lease.jobId, leaseToken: lease.leaseToken,
            errorCode: boundedText(status?.statusCode || 'QBD_ERROR', 64),
            errorDetail: boundedText(status?.statusMessage || 'QuickBooks rejected request'),
            outcomeKnown: true,
          });
          leases.delete(ticket);
          return;
        }
        const rets = parseBillRets(response);
        if (lease.operation === 'query') {
          const matches = rets.filter((ret) => !billMismatch(ret, {
            txn: lease.requestPayload.txn ?? {},
          }));
          if (matches.length > 1) throw new Error('QBD_AMBIGUOUS_PREFLIGHT');
          await jobs.completePreflight({
            tenantId: lease.tenantId, connectionId: lease.connectionId,
            proposalId: lease.proposalId, jobId: lease.jobId, leaseToken: lease.leaseToken,
            txn: lease.requestPayload.txn ?? {}, expectedCompanyId: lease.companyId,
            providerResponse: safe,
            ...(matches[0] ? { existing: {
              externalId: matches[0].txnId, revision: matches[0].editSequence,
            } } : {}),
          });
          leases.delete(ticket);
          await enqueueLeasedWork(ticket, lease.companyId, {
            id: lease.connectionId, tenant_id: lease.tenantId,
          }, jobs, leases);
          return;
        } else if (lease.operation === 'post_bill') {
          const ret = rets[0];
          if (!ret) throw new Error('QBD_MALFORMED');
          await jobs.acknowledgeCreateAndQueueReadBack({
            tenantId: lease.tenantId, connectionId: lease.connectionId,
            proposalId: lease.proposalId, jobId: lease.jobId, leaseToken: lease.leaseToken,
            externalId: ret.txnId, revision: ret.editSequence, providerResponse: safe,
            txn: lease.requestPayload.txn ?? {}, expectedCompanyId: lease.companyId,
          });
        } else {
          const candidates = rets.filter((ret) => !billMismatch(ret, {
            externalId: lease.requestPayload.externalId
              ? String(lease.requestPayload.externalId)
              : undefined,
            txn: lease.requestPayload.txn ?? {},
          }));
          if (candidates.length !== 1) {
            throw new Error(candidates.length ? 'QBD_AMBIGUOUS_READ_BACK' : 'QBD_READ_BACK_MISMATCH');
          }
          await finalizeQbdReadBack({
            tenantId: lease.tenantId, connectionId: lease.connectionId,
            proposalId: lease.proposalId, companyId: lease.companyId,
            jobId: lease.jobId, leaseToken: lease.leaseToken,
            ret: candidates[0]!, response: safeProviderResponse(response),
          });
        }
        leases.delete(ticket);
      } catch (error) {
        if (lease.operation === 'read_back' || lease.operation === 'query') {
          const detail = boundedText((error as Error).message);
          const accountingHold = /^(QBD_(?:AMBIGUOUS|READ_BACK|COMPANY)|COMPANY_|PARENT_|PROPOSAL_|POSTING_|STALE_)/.test(detail);
          if (accountingHold) {
            await jobs.hold({
              tenantId: lease.tenantId, jobId: lease.jobId, leaseToken: lease.leaseToken,
              errorCode: lease.operation === 'query' ? 'PREFLIGHT_AMBIGUOUS' : 'READ_BACK_MISMATCH',
              errorDetail: detail,
            });
          } else {
            // Queries are non-mutating, so infrastructure failures are safely
            // retryable and must not be mislabeled as accounting mismatches.
            await jobs.fail({
              tenantId: lease.tenantId, jobId: lease.jobId, leaseToken: lease.leaseToken,
              errorCode: 'READ_QUERY_INFRASTRUCTURE', errorDetail: detail, outcomeKnown: true,
            });
          }
        } else {
          await jobs.fail({
            tenantId: lease.tenantId, jobId: lease.jobId, leaseToken: lease.leaseToken,
            errorCode: 'QBD_RESPONSE_INVALID', errorDetail: boundedText((error as Error).message),
            // Once BillAdd has been transmitted, parsing, persistence, or any
            // other non-authoritative failure is ambiguous and must never replay.
            outcomeKnown: false,
          });
        }
        leases.delete(ticket);
      }
    },
    async closed(ticket) {
      leases.delete(ticket);
      pendingCompany.delete(ticket);
    },
  };
}

export async function activeQbdConnection(tenantId: number): Promise<{
  id: number; external_company: string; metadata: Record<string, unknown>;
} | null> {
  return (await query<{
    id: number; external_company: string; metadata: Record<string, unknown>;
  }>(
    `SELECT id,external_company,metadata FROM connections
      WHERE tenant_id=$1 AND provider='qbd' AND connection_class='local_desktop'
        AND status='active' ORDER BY updated_at DESC,id DESC LIMIT 1`,
    [tenantId],
  )).rows[0] ?? null;
}

/**
 * Production QBD approval boundary. It never talks to Desktop synchronously:
 * PostgreSQL owns the stable posting intent until QBWC leases it.
 */
export async function enqueueApprovedQbdBill(
  tenantId: number,
  proposalId: number,
  jobs = new DurableProviderJobs(),
  safety?: { enabled: boolean; writeEnabled: boolean; companyId: string },
): Promise<{ status: 'queued'; providerJobId: number }> {
  const gate = safety ?? (() => {
    const cfg = config();
    return {
      enabled: cfg.QB_DESKTOP_ENABLED,
      writeEnabled: cfg.QB_DESKTOP_WRITE_ENABLED,
      companyId: cfg.QB_DESKTOP_COMPANY_ID,
    };
  })();
  if (!gate.enabled || !gate.writeEnabled) {
    throw new Error('QBD_WRITE_DISABLED');
  }
  const connection = await activeQbdConnection(tenantId);
  if (!connection) throw new Error('QBD_CONNECTION_UNAVAILABLE');
  const expected = String(connection.metadata.expectedCompanyId ?? connection.external_company ?? '');
  if (!expected || expected !== gate.companyId) throw new Error('COMPANY_IDENTITY_MISMATCH');
  // Injected safety is the legacy contract-test seam; production callers omit it
  // and must satisfy the independently persisted human owner gate.
  if (!safety && !ownerGateEnabled(connection.metadata, expected)) throw new Error('QBD_OWNER_WRITE_GATE_DISABLED');
  const proposal = (await query<{
    id: number; extraction_id: number | null; proposed_txn: Record<string, unknown>;
    idempotency_key: string | null; status: string;
  }>(
    `SELECT id,extraction_id,proposed_txn,idempotency_key,status FROM proposals
      WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
    [tenantId, proposalId],
  )).rows[0];
  if (!proposal || proposal.status !== 'ready' || !proposal.idempotency_key) {
    throw new Error('PROPOSAL_NOT_READY');
  }
  const invoiceProof = await hasProofRef(tenantId, 'proposal', String(proposalId), 'invoiceproof');
  const verifyProof = proposal.extraction_id
    ? await hasProofRef(tenantId, 'extraction', String(proposal.extraction_id), 'verify_api')
    : false;
  if (!invoiceProof || !verifyProof) throw new Error('PROOF_REQUIRED');
  const job = await jobs.enqueue({
    tenantId,
    connectionId: connection.id,
    proposalId,
      operation: 'query',
    requestPayload: {
      txn: proposal.proposed_txn,
      expectedCompanyId: expected,
      proposalId,
      postingIdempotencyKey: proposal.idempotency_key,
    },
    sourceKey: `preflight:proposal:${proposalId}:${proposal.idempotency_key}`,
  });
  return { status: 'queued', providerJobId: job.id };
}
