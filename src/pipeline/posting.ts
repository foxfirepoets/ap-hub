import { query } from '../db/pool.js';
import { raiseException, openExceptionsFor } from '../exceptions.js';
import { recordProofRef, hasProofRef } from '../swarmsync/proof.js';
import { writeAudit, hashOf } from '../audit.js';
import { logger } from '../logger.js';
import type { QboWriteClient } from '../qbo/write.js';
import type { VerifyResult } from '../swarmsync/client.js';
import type { SwarmSyncMode } from '../config.js';

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
  /** The proof-coverage gate applies only when SwarmSync is enabled (default true). */
  swarmSyncEnabled?: boolean;
  /** SwarmSync mode; 'off_review' must never post (defense-in-depth). Default 'on'. */
  swarmSyncMode?: SwarmSyncMode;
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
  // Defense-in-depth: in off_review mode nothing auto-posts, no matter how a
  // proposal reached 'ready' (mapping already caps it; this is the backstop).
  if (deps.swarmSyncMode === 'off_review') return { status: 'held', reason: 'swarmsync_off_review' };
  if (Number(p.confidence) < deps.autoThreshold) return { status: 'held', reason: 'below_auto_threshold' };
  const total = Number(p.proposed_txn?.TotalAmt ?? 0);
  if (total > deps.amountCeiling) return { status: 'held', reason: 'over_ceiling' };
  if ((p.flags ?? []).some((f) => BLOCKING_FLAGS.includes(f))) return { status: 'held', reason: 'blocking_flag' };
  if (!p.idempotency_key) return { status: 'held', reason: 'no_idempotency_key' };

  // Proof gate (Amendment A1-P2.1): both proofs present, no open proof_scan_unavailable.
  // Applies ONLY when SwarmSync is enabled; when disabled the operator has opted
  // out of proof coverage (mapping decides review vs auto-post), so the gate is
  // skipped here and posting proceeds on the other gates above.
  if (deps.swarmSyncEnabled !== false) {
    const hasInvoiceProof = await hasProofRef(tenantId, 'proposal', String(proposalId), 'invoiceproof');
    const hasVerify = p.extraction_id
      ? await hasProofRef(tenantId, 'extraction', String(p.extraction_id), 'verify_api')
      : false;
    if (!hasInvoiceProof || !hasVerify) return { status: 'held', reason: 'missing_proof_coverage' };
    if (p.extraction_id && (await openExceptionsFor(tenantId, `extraction:${p.extraction_id}`, 'proof_scan_unavailable')) > 0) {
      return { status: 'held', reason: 'open_proof_scan_unavailable' };
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
    try {
      const existing = await deps.writer.queryExisting(txnType, dedupWhere);
      if (existing.length > 0) {
        const qId = String((existing[0] as any).Id ?? '');
        await recordPosting(tenantId, p, txnType, qId, '0', { adopted: true }, existing[0]);
        await raiseException({ tenantId, reasonCode: 'duplicate_in_qbo', entityRef: `proposal:${proposalId}`, detail: 'qbo query hit' });
        return { status: 'duplicate' };
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'dedup query failed (continuing to create with replay-safety)');
    }
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
  if (!verifyMatches(txn, readBack)) {
    await recordPosting(tenantId, p, txnType, created.id, created.syncToken, { verifyMismatch: true }, readBack, 'verify_mismatch');
    await raiseException({ tenantId, reasonCode: 'verify_mismatch', entityRef: `posting:${created.id}`, detail: 'read-back mismatch' });
    return { status: 'held', reason: 'verify_mismatch' };
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
  // Skipped when SwarmSync is disabled (no outbound anchor call).
  if (deps.swarmSyncEnabled !== false && !(await hasProofRef(tenantId, 'posting', String(postingId), 'auditproof'))) {
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
  const res = await query<{ id: number }>(
    `INSERT INTO postings (tenant_id, attachment_id, proposal_id, qbo_type, qbo_id, sync_token, realm, mode, idempotency_key, status, request, response, posted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'sandbox',$8,$9,$10,$11, now())
     ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET qbo_id=EXCLUDED.qbo_id, sync_token=EXCLUDED.sync_token
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
  const lines = (txn.lines ?? []).map((l: any) => ({
    Amount: l.Amount,
    DetailType: 'AccountBasedExpenseLineDetail',
    Description: l.description,
    AccountBasedExpenseLineDetail: l.accountRef ? { AccountRef: { value: l.accountRef.value } } : {},
  }));
  const payload: Record<string, unknown> = {
    Line: lines.length ? lines : [{ Amount: txn.TotalAmt, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: {} }],
    TxnDate: txn.TxnDate,
    DocNumber: txn.DocNumber,
  };
  if (txn.vendorRef) payload.VendorRef = { value: txn.vendorRef.value };
  return payload;
}

function verifyMatches(txn: any, readBack: any): boolean {
  const amtA = Number(txn?.TotalAmt ?? 0);
  const amtB = Number(readBack?.TotalAmt ?? 0);
  if (Math.abs(amtA - amtB) > 0.01) return false;
  if (txn?.DocNumber && readBack?.DocNumber && String(txn.DocNumber) !== String(readBack.DocNumber)) return false;
  return true;
}

export async function postSandboxHandler(job: { data: PostJob }): Promise<void> {
  const { config, swarmSyncMode } = await import('../config.js');
  const { getQboWriteClient } = await import('../qbo/write.js');
  const { swarmsync } = await import('../services.js');
  const { loadAttachmentBytes } = await import('../ingest/repo.js');
  const cfg = config();
  const writer = await getQboWriteClient(job.data.tenantId);
  await postOnce(job.data.tenantId, job.data.proposalId, {
    writer,
    anchor: (output) => swarmsync().auditProof(output),
    loadPdf: async (attachmentId) => {
      const sha = (await query<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id=$1', [attachmentId])).rows[0]?.sha256;
      return sha ? loadAttachmentBytes(sha) : null;
    },
    amountCeiling: cfg.AMOUNT_CEILING,
    autoThreshold: cfg.AUTO_THRESHOLD,
    swarmSyncEnabled: cfg.SWARMSYNC_ENABLED,
    swarmSyncMode: swarmSyncMode(cfg),
  });
}
