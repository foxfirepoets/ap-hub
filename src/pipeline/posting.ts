import { query } from '../db/pool.js';
import { raiseException, openExceptionsFor } from '../exceptions.js';
import { recordProofRef, hasProofRef } from '../swarmsync/proof.js';
import { writeAudit, hashOf } from '../audit.js';
import { logger } from '../logger.js';
import { evaluateTax } from '../mapping/tax.js';
import { mappedSupportedDimensions, SUPPORTED_DIMENSION_KINDS } from '../mapping/dimensions.js';
import type { CanonicalDimension } from '../canonical/model.js';
import type { QboWriteClient } from '../qbo/write.js';
import type { VerifyResult } from '../swarmsync/client.js';

export interface PostJob {
  tenantId: number;
  proposalId: number;
}

export interface PostDeps {
  writer: QboWriteClient;
  anchor: (output: unknown) => Promise<VerifyResult>;
  loadPdf: (attachmentId: number) => Promise<Buffer | null>;
  amountCeiling: number;
  autoThreshold: number;
  // FIX-F5: optional wrong-company guard. When provided, a 'mismatch' holds and
  // never creates. Omitted in unit tests → check is skipped (behavior unchanged).
  verifyCompany?: () => Promise<'match' | 'mismatch'>;
}

export type PostResult =
  | { status: 'posted'; postingId: number; qboId: string }
  | { status: 'held'; reason: string }
  | { status: 'duplicate' }
  | { status: 'skipped'; reason: string };

const BLOCKING_FLAGS = [
  'duplicate',
  'total_mismatch',
  'bank_change_warning',
  'unknown_vendor',
  'unmapped_account',
  'unmapped_dimension',
  'fraud_flag',
  'proof_scan_unavailable',
  // F5 vendor review policy: a fuzzy/ambiguous/OCR-derived vendor match can never
  // auto-post even if it slipped past the propose-time gate (defense in depth).
  'vendor_review',
];

export async function postOnce(tenantId: number, proposalId: number, deps: PostDeps): Promise<PostResult> {
  const p = (
    await query<{
      id: number;
      attachment_id: number | null;
      extraction_id: number | null;
      proposed_txn: any;
      idempotency_key: string | null;
      confidence: string;
      status: string;
      flags: string[];
    }>(
      'SELECT id, attachment_id, extraction_id, proposed_txn, idempotency_key, confidence, status, flags FROM proposals WHERE tenant_id=$1 AND id=$2',
      [tenantId, proposalId],
    )
  ).rows[0];
  if (!p) return { status: 'skipped', reason: 'not_found' };

  // --- Gate ---
  if (p.status !== 'ready') return { status: 'held', reason: `status=${p.status}` };
  if (Number(p.confidence) < deps.autoThreshold) return { status: 'held', reason: 'below_auto_threshold' };
  const total = Number(p.proposed_txn?.TotalAmt ?? 0);
  if (total > deps.amountCeiling) return { status: 'held', reason: 'over_ceiling' };
  if ((p.flags ?? []).some((f) => BLOCKING_FLAGS.includes(f))) return { status: 'held', reason: 'blocking_flag' };
  if (!p.idempotency_key) return { status: 'held', reason: 'no_idempotency_key' };

  // Proof gate (Amendment A1-P2.1): both proofs present, no open proof_scan_unavailable.
  const hasInvoiceProof = await hasProofRef(tenantId, 'proposal', String(proposalId), 'invoiceproof');
  const hasVerify = p.extraction_id
    ? await hasProofRef(tenantId, 'extraction', String(p.extraction_id), 'verify_api')
    : false;
  if (!hasInvoiceProof || !hasVerify) return { status: 'held', reason: 'missing_proof_coverage' };
  if (p.extraction_id && (await openExceptionsFor(tenantId, `extraction:${p.extraction_id}`, 'proof_scan_unavailable')) > 0) {
    return { status: 'held', reason: 'open_proof_scan_unavailable' };
  }

  // --- Wrong-company guard (FIX-F5): never write into the wrong QBO company ---
  if (deps.verifyCompany) {
    if ((await deps.verifyCompany()) === 'mismatch') {
      await raiseException({ tenantId, reasonCode: 'company_mismatch', entityRef: `proposal:${proposalId}`, detail: 'company identity mismatch' });
      return { status: 'held', reason: 'company_mismatch' };
    }
  }

  const txn = p.proposed_txn;
  const txnType: string = txn.txnType ?? 'Bill';

  // --- Layer 1 dedup: local idempotency key ---
  const existingLocal = (
    await query<{ id: number; qbo_id: string | null }>(
      'SELECT id, qbo_id FROM postings WHERE tenant_id=$1 AND idempotency_key=$2',
      [tenantId, p.idempotency_key],
    )
  ).rows[0];
  if (existingLocal) {
    await raiseException({ tenantId, reasonCode: 'duplicate_in_qbo', entityRef: `proposal:${proposalId}`, detail: 'local idempotency hit' });
    return { status: 'duplicate' };
  }

  // --- Layer 2 dedup: QBO existence query ---
  const dedupWhere = buildDedupWhere(txn);
  if (dedupWhere) {
    let existing;
    try {
      existing = await deps.writer.queryExisting(txnType, dedupWhere);
    } catch (err) {
      // FIX-F5 fail-closed: if the PRE-create dedup query throws, the duplicate
      // state is unknown — never blind-create. Hold and raise a typed exception.
      logger.warn({ err: String(err) }, 'pre-create dedup query failed → holding (fail-closed)');
      await raiseException({ tenantId, reasonCode: 'dedup_unavailable', entityRef: `proposal:${proposalId}`, detail: String(err) });
      return { status: 'held', reason: 'dedup_unavailable' };
    }
    if (existing.length > 0) {
      const qId = String((existing[0] as any).Id ?? '');
      await recordPosting(tenantId, p, txnType, qId, '0', { adopted: true }, existing[0]);
      await raiseException({ tenantId, reasonCode: 'duplicate_in_qbo', entityRef: `proposal:${proposalId}`, detail: 'qbo query hit' });
      return { status: 'duplicate' };
    }
  }

  // --- Tax gate (F5): a NAMED hold BEFORE create when tax cannot be handled. Replaces
  // the old fail-safe where taxed invoices only failed later via read-back mismatch. A
  // tax line is added to the payload ONLY when a configured code exists AND it reconciles.
  const taxDecision = evaluateTax(txn);
  if (taxDecision.kind === 'hold') {
    await raiseException({
      tenantId,
      reasonCode: taxDecision.reason,
      entityRef: `proposal:${proposalId}`,
      detail: JSON.stringify({ message: taxDecision.detail, evidence: taxDecision.evidence }),
    });
    return { status: 'held', reason: taxDecision.reason };
  }

  // --- Create ---
  const payload = buildQboPayload(txnType, txn);
  let created;
  try {
    created = await deps.writer.createEntity(txnType, payload, p.idempotency_key);
  } catch (err: any) {
    // 6190 duplicate → treat as dedup hit, link (do not blind-retry).
    if (String(err?.body ?? '').includes('6190')) {
      await raiseException({ tenantId, reasonCode: 'duplicate_in_qbo', entityRef: `proposal:${proposalId}`, detail: '6190' });
      return { status: 'duplicate' };
    }
    // Unknown outcome (timeout) → replay-adopt via dedup query before any retry.
    if (dedupWhere) {
      try {
        const existing = await deps.writer.queryExisting(txnType, dedupWhere);
        if (existing.length > 0) {
          const qId = String((existing[0] as any).Id ?? '');
          await recordPosting(tenantId, p, txnType, qId, '0', { adoptedAfterTimeout: true }, existing[0]);
          return { status: 'posted', postingId: -1, qboId: qId };
        }
      } catch {
        /* fall through to exception */
      }
    }
    await raiseException({ tenantId, reasonCode: 'qbo_api_error', entityRef: `proposal:${proposalId}`, detail: String(err?.message ?? err) });
    throw err;
  }

  // --- Attach PDF (retry attach only on failure; never re-create) ---
  if (p.attachment_id) {
    const pdf = await deps.loadPdf(p.attachment_id);
    if (pdf) {
      try {
        await deps.writer.attach(txnType, created.id, pdf, `invoice-${created.id}.pdf`);
      } catch (err) {
        await raiseException({ tenantId, reasonCode: 'attachment_failed', entityRef: `posting:${created.id}`, detail: String(err) });
      }
    }
  }

  // --- Read-back verify (no retry on mismatch) ---
  const readBack = await deps.writer.readEntity(txnType, created.id);
  // Core amount/DocNumber check is unchanged and still fully authoritative.
  if (!verifyMatches(txn, readBack)) {
    await recordPosting(tenantId, p, txnType, created.id, created.syncToken, { verifyMismatch: true }, readBack, 'verify_mismatch');
    await raiseException({ tenantId, reasonCode: 'verify_mismatch', entityRef: `posting:${created.id}`, detail: 'read-back mismatch' });
    return { status: 'held', reason: 'verify_mismatch' };
  }
  // F5: dimensions we approved+wrote must survive read-back. A material mismatch (the
  // provider dropped or altered a dimension) marks the posting unverified and raises a
  // dedicated dimension_mismatch exception — the amount/DocNumber checks above are intact.
  const dimMiss = firstDimensionMismatch(txn, readBack);
  if (dimMiss) {
    await recordPosting(tenantId, p, txnType, created.id, created.syncToken, { dimensionMismatch: dimMiss }, readBack, 'dimension_mismatch');
    await raiseException({ tenantId, reasonCode: 'dimension_mismatch', entityRef: `posting:${created.id}`, detail: JSON.stringify(dimMiss) });
    return { status: 'held', reason: 'dimension_mismatch' };
  }

  const postingId = await recordPosting(tenantId, p, txnType, created.id, created.syncToken, payload, readBack, 'posted_sandbox');
  await query('UPDATE proposals SET status=$2 WHERE id=$1', [proposalId, 'posted_sandbox']);
  await query(
    `INSERT INTO reconciliation (tenant_id, kind, left_ref, right_ref, match_status, variance)
     VALUES ($1,'proposal_vs_created',$2,$3,'matched',$4)`,
    [tenantId, `proposal:${proposalId}`, `qbo:${created.id}`, JSON.stringify({ diffHash: hashOf(readBack) })],
  );
  await writeAudit({
    tenantId,
    action: 'post.sandbox',
    entity: `posting:${postingId}`,
    realm: deps.writer.realm,
    afterHash: hashOf(readBack),
    detail: { qboId: created.id, txnType },
  });

  // --- AuditProof anchor (A1-P2.2): anchor failure NEVER re-creates the txn ---
  if (!(await hasProofRef(tenantId, 'posting', String(postingId), 'auditproof'))) {
    try {
      const v = await deps.anchor({
        realm: deps.writer.realm,
        qbo_id: created.id,
        entity_type: txnType,
        idempotency_key: p.idempotency_key,
        diff_hash: hashOf(readBack),
        posted_at: null,
      });
      await recordProofRef({
        tenantId,
        entityKind: 'posting',
        entityId: String(postingId),
        product: 'auditproof',
        proofId: v.proof_id,
        chainHash: v.chain_hash,
        verdict: v.verification_status,
        response: v.raw,
      });
    } catch (err) {
      logger.warn({ err: String(err), postingId }, 'auditproof anchor failed (txn intact, will retry anchor only)');
      await raiseException({
        tenantId,
        reasonCode: 'proof_scan_unavailable',
        entityRef: `posting:${postingId}`,
        detail: `AuditProof anchor failed: ${(err as Error).message}`,
      });
    }
  }

  return { status: 'posted', postingId, qboId: created.id };
}

async function recordPosting(
  tenantId: number,
  proposal: { id: number; attachment_id: number | null; idempotency_key: string | null },
  txnType: string,
  qboId: string,
  syncToken: string,
  request: unknown,
  response: unknown,
  status = 'posted_sandbox',
): Promise<number> {
  // Writes go to the base table `postings_ap` (provider-neutral columns). The old
  // `postings(qbo_*)` names remain available via the back-compat view; ON CONFLICT is
  // not supported on views, so the upsert targets the base table directly.
  const res = await query<{ id: number }>(
    `INSERT INTO postings_ap (tenant_id, attachment_id, proposal_id, entity_type, external_id, revision, realm, mode, idempotency_key, status, request, response, posted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'sandbox',$8,$9,$10,$11, now())
     ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET external_id=EXCLUDED.external_id, revision=EXCLUDED.revision
     RETURNING id`,
    [
      tenantId,
      proposal.attachment_id,
      proposal.id,
      txnType,
      qboId,
      syncToken,
      'sandbox',
      proposal.idempotency_key,
      status,
      JSON.stringify(request),
      JSON.stringify(response),
    ],
  );
  return res.rows[0]!.id;
}

function buildDedupWhere(txn: any): string | null {
  const vendor = txn?.vendorRef?.value;
  const doc = txn?.DocNumber;
  if (!vendor && !doc) return null;
  const parts: string[] = [];
  if (doc) parts.push(`DocNumber = '${String(doc).replace(/'/g, '')}'`);
  if (txn?.TxnDate) parts.push(`TxnDate = '${String(txn.TxnDate).replace(/'/g, '')}'`);
  return parts.join(' AND ') || null;
}

function buildQboPayload(_txnType: string, txn: any): Record<string, unknown> {
  // F5 dimension carry-through: only mapped, provider-representable dimensions are
  // emitted. Anything unsupported/not-mapped was already held before create.
  const headerDims = mappedSupportedDimensions(txn.dimensions);
  const headerClass = headerDims.find((d) => d.kind === 'class');
  const headerLocation = headerDims.find((d) => d.kind === 'location');

  const lines = (txn.lines ?? []).map((l: any) => {
    const detail: Record<string, unknown> = l.accountRef ? { AccountRef: { value: l.accountRef.value } } : {};
    const lineDims = mappedSupportedDimensions(l.dimensions);
    const cls = lineDims.find((d) => d.kind === 'class') ?? headerClass;
    if (cls?.id) detail.ClassRef = { value: cls.id };
    return {
      Amount: l.Amount,
      DetailType: 'AccountBasedExpenseLineDetail',
      Description: l.description,
      AccountBasedExpenseLineDetail: detail,
    };
  });
  const fallbackDetail: Record<string, unknown> = {};
  if (headerClass?.id) fallbackDetail.ClassRef = { value: headerClass.id };
  const payload: Record<string, unknown> = {
    Line: lines.length
      ? lines
      : [{ Amount: txn.TotalAmt, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: fallbackDetail }],
    TxnDate: txn.TxnDate,
    DocNumber: txn.DocNumber,
  };
  if (txn.DueDate) payload.DueDate = txn.DueDate;
  if (txn.vendorRef) payload.VendorRef = { value: txn.vendorRef.value };
  // Location is a header-level dimension on a QBO Bill.
  if (headerLocation?.id) payload.DepartmentRef = { value: headerLocation.id };

  // Tax line — added ONLY when evaluateTax approved a configured, reconciling code.
  const tax = evaluateTax(txn);
  if (tax.kind === 'ok' && tax.tax.code) {
    payload.TxnTaxDetail = { TotalTax: tax.tax.amount, TxnTaxCodeRef: { value: String(tax.tax.code) } };
  }
  return payload;
}

function verifyMatches(txn: any, readBack: any): boolean {
  const amtA = Number(txn?.TotalAmt ?? 0);
  const amtB = Number(readBack?.TotalAmt ?? 0);
  if (Math.abs(amtA - amtB) > 0.01) return false;
  if (txn?.DocNumber && readBack?.DocNumber && String(txn.DocNumber) !== String(readBack.DocNumber)) return false;
  return true;
}

/** The value the provider echoed back for a written dimension, or undefined if absent. */
function readBackDimensionValue(kind: string, readBack: any): string | undefined {
  if (kind === 'location') {
    const v = readBack?.DepartmentRef?.value;
    return v == null ? undefined : String(v);
  }
  if (kind === 'class') {
    const lines: any[] = Array.isArray(readBack?.Line) ? readBack.Line : [];
    for (const l of lines) {
      const v = l?.AccountBasedExpenseLineDetail?.ClassRef?.value;
      if (v != null) return String(v);
    }
    const headerV = readBack?.ClassRef?.value;
    return headerV == null ? undefined : String(headerV);
  }
  return undefined;
}

/**
 * Returns the first dimension we approved+wrote that the read-back did not confirm
 * (missing or a different id) — or null when every written dimension survived. Only the
 * mapped, provider-representable dimensions are checked (the only ones we ever emit).
 */
function firstDimensionMismatch(
  txn: any,
  readBack: any,
): { kind: string; expected: string; found: string | null } | null {
  const dims: CanonicalDimension[] = [
    ...mappedSupportedDimensions(txn?.dimensions),
    ...(Array.isArray(txn?.lines) ? txn.lines.flatMap((l: any) => mappedSupportedDimensions(l?.dimensions)) : []),
  ].filter((d) => SUPPORTED_DIMENSION_KINDS.includes(d.kind as (typeof SUPPORTED_DIMENSION_KINDS)[number]));
  for (const d of dims) {
    if (!d.id) continue;
    const found = readBackDimensionValue(d.kind, readBack);
    if (found !== String(d.id)) {
      return { kind: d.kind, expected: String(d.id), found: found ?? null };
    }
  }
  return null;
}

export async function postSandboxHandler(job: { data: PostJob }): Promise<void> {
  const { config } = await import('../config.js');
  const { getQboWriteClient } = await import('../qbo/write.js');
  const { swarmsync } = await import('../services.js');
  const { loadAttachmentBytes } = await import('../ingest/repo.js');
  const cfg = config();
  const writer = await getQboWriteClient(job.data.tenantId);

  // FIX-F5 / F4-WIRE: enforce the wrong-company guard only when an expected company
  // name is configured. Identity is now checked through the provider-neutral
  // AccountingConnector (src/connectors/qbo.ts), which wraps the same read/write
  // clients — delegation only, no parallel QBO implementation.
  const expectedCompany = (cfg.QBO_SANDBOX_COMPANY_NAME ?? '').trim();
  const verifyCompany = expectedCompany
    ? async (): Promise<'match' | 'mismatch'> => {
        try {
          const { getQboReadClient } = await import('../qbo/client.js');
          const { createQboConnector } = await import('../connectors/qbo.js');
          const read = await getQboReadClient(job.data.tenantId);
          const connector = createQboConnector({ writeClient: writer, readClient: read, expectedCompanyName: expectedCompany });
          return await connector.verifyCompanyIdentity({ name: expectedCompany });
        } catch (err) {
          // Only a DEFINITIVE identity read can hold. Identity is already asserted at
          // connect (auth/qbo-oauth) and sandbox-only at write-client construction;
          // this is a defense-in-depth double check, so an unreadable identity does
          // not block posting (and never silently forces the wrong company).
          logger.warn({ err: String(err) }, 'company identity read failed → skipping wrong-company double check');
          return 'match';
        }
      }
    : undefined;

  await postOnce(job.data.tenantId, job.data.proposalId, {
    writer,
    anchor: (output) => swarmsync().auditProof(output),
    loadPdf: async (attachmentId) => {
      const sha = (await query<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id=$1', [attachmentId])).rows[0]?.sha256;
      return sha ? loadAttachmentBytes(sha) : null;
    },
    amountCeiling: cfg.AMOUNT_CEILING,
    autoThreshold: cfg.AUTO_THRESHOLD,
    verifyCompany,
  });
}
