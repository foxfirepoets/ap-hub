import { query } from '../db/pool.js';
import { raiseException, openExceptionsFor } from '../exceptions.js';
import { recordProofRef, hasProofRef } from '../swarmsync/proof.js';
import { writeAudit, hashOf } from '../audit.js';
import { logger } from '../logger.js';
import { evaluateTax, evaluateTaxMappingRecord } from '../mapping/tax.js';
import { evaluateDimensionMappingRecord } from '../mapping/dimensions.js';
import { listTaxMappings } from '../mapping/taxMappingStore.js';
import type { AccountingConnector } from '../connectors/types.js';
import type { VerifyResult } from '../swarmsync/client.js';
import type { CanonicalDimension } from '../canonical/model.js';
import type { SwarmSyncMode } from '../config.js';

export interface PostJob {
  tenantId: number;
  proposalId: number;
}

export interface PostDeps {
  // F4: the ONLY live accounting path is the provider-neutral connector. The pipeline
  // never imports or calls a provider write module; the adapter owns all translation.
  connector: AccountingConnector;
  anchor: (output: unknown) => Promise<VerifyResult>;
  loadPdf: (attachmentId: number) => Promise<Buffer | null>;
  amountCeiling: number;
  autoThreshold: number;
  // Wrong-company guard: when an expected company name is configured, identity is
  // verified through the connector before any write; 'mismatch' holds, never creates.
  expectedCompanyName?: string;
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
  // Defense-in-depth: in off_review mode nothing auto-posts, no matter how a
  // proposal reached 'ready' (mapping already caps it; this is the backstop).
  if (deps.swarmSyncMode === 'off_review') return { status: 'held', reason: 'swarmsync_off_review' };
  if (Number(p.confidence) < deps.autoThreshold) return { status: 'held', reason: 'below_auto_threshold' };
  const total = Number(p.proposed_txn?.TotalAmt ?? 0);
  if (total > deps.amountCeiling) return { status: 'held', reason: 'over_ceiling' };
  if ((p.flags ?? []).some((f) => BLOCKING_FLAGS.includes(f))) return { status: 'held', reason: 'blocking_flag' };
  if (!p.idempotency_key) return { status: 'held', reason: 'no_idempotency_key' };

  // Proof coverage is unconditional. If the integration is disabled or down,
  // proofs are absent and the proposal holds rather than weakening the control.
  const hasInvoiceProof = await hasProofRef(tenantId, 'proposal', String(proposalId), 'invoiceproof');
  const hasVerify = p.extraction_id
    ? await hasProofRef(tenantId, 'extraction', String(p.extraction_id), 'verify_api')
    : false;
  if (!hasInvoiceProof || !hasVerify) return { status: 'held', reason: 'missing_proof_coverage' };
  if (p.extraction_id && (await openExceptionsFor(tenantId, `extraction:${p.extraction_id}`, 'proof_scan_unavailable')) > 0) {
    return { status: 'held', reason: 'open_proof_scan_unavailable' };
  }

  // --- Wrong-company guard (F5/F4): verify identity through the connector before any
  // write. Only enforced when an expected company name is configured. ---
  if (deps.expectedCompanyName) {
    if ((await deps.connector.verifyCompanyIdentity({ name: deps.expectedCompanyName })) === 'mismatch') {
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

  // --- Layer 2 dedup: provider existence probe (through the connector) ---
  let existing;
  try {
    existing = await deps.connector.detectExisting(txn, p.idempotency_key);
  } catch (err) {
    // Fail-closed: if the pre-create dedup probe throws, the duplicate state is unknown
    // — never blind-create. Hold and raise a typed exception.
    logger.warn({ err: String(err) }, 'pre-create dedup probe failed → holding (fail-closed)');
    await raiseException({ tenantId, reasonCode: 'dedup_unavailable', entityRef: `proposal:${proposalId}`, detail: String(err) });
    return { status: 'held', reason: 'dedup_unavailable' };
  }
  if (existing) {
    await recordPosting(tenantId, p, txnType, existing.externalId, existing.revision, { adopted: true }, existing.raw);
    await raiseException({ tenantId, reasonCode: 'duplicate_in_qbo', entityRef: `proposal:${proposalId}`, detail: 'provider existence hit' });
    return { status: 'duplicate' };
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

  // --- Tax MAPPING gate (fail-closed): a reconciling in-memory decision is not enough —
  // the resolved code must have an active, non-stale tax_mappings row (migration 007)
  // before it may post. Missing/inactive/needs_revalidation all hold, never guess.
  if (taxDecision.kind === 'ok') {
    const code = String(taxDecision.tax.code);
    const connRow = (
      await query<{ id: number }>(
        'SELECT id FROM connections WHERE tenant_id=$1 AND provider=$2 AND external_company=$3',
        [tenantId, deps.connector.provider, deps.connector.companyId],
      )
    ).rows[0];
    let mappingRecord: { active: boolean; needsRevalidation: boolean } | null = null;
    if (connRow) {
      const matches = (
        await listTaxMappings(tenantId, { connectionId: connRow.id, provider: deps.connector.provider })
      ).filter((r) => r.providerTaxCode === code);
      const chosen = matches.find((r) => r.active) ?? matches[0] ?? null;
      if (chosen) mappingRecord = { active: chosen.active, needsRevalidation: chosen.needsRevalidation };
    }
    const taxGate = evaluateTaxMappingRecord(code, mappingRecord);
    if (taxGate.kind === 'hold') {
      await raiseException({ tenantId, reasonCode: taxGate.reason, entityRef: `proposal:${proposalId}`, detail: taxGate.detail });
      return { status: 'held', reason: taxGate.reason };
    }
  }

  // --- Dimension MAPPING gate (fail-closed): each present, non-blank dimension must have
  // a persisted, human-reviewed dimension_mappings row (migration 007, proposal-scoped)
  // confirming resolution_state='mapped' + review_status accepted/corrected. A missing
  // row, an unresolved state, or a rejected/held review all hold — an
  // intentionally_blank dimension always passes through blank, never held.
  const txnDimensions: CanonicalDimension[] = Array.isArray(txn.dimensions) ? txn.dimensions : [];
  if (txnDimensions.length) {
    const dimRows = (
      await query<{ dimension_type: string; resolution_state: string; review_status: string }>(
        'SELECT dimension_type, resolution_state, review_status FROM dimension_mappings WHERE tenant_id=$1 AND proposal_id=$2',
        [tenantId, proposalId],
      )
    ).rows;
    for (const dim of txnDimensions) {
      const row = dimRows.find((r) => r.dimension_type === dim.kind);
      const record = row ? { resolutionState: row.resolution_state, reviewStatus: row.review_status } : null;
      const dimGate = evaluateDimensionMappingRecord(dim, record);
      if (dimGate.kind === 'hold') {
        await raiseException({ tenantId, reasonCode: dimGate.reason, entityRef: `proposal:${proposalId}`, detail: dimGate.detail });
        return { status: 'held', reason: dimGate.reason };
      }
    }
  }

  // --- Create (through the connector — the sole live accounting path) ---
  let created;
  try {
    created = await deps.connector.postBill(txn, p.idempotency_key);
  } catch (err: any) {
    // Provider duplicate signal → treat as dedup hit, link (do not blind-retry).
    if (String(err?.body ?? '').includes('6190')) {
      await raiseException({ tenantId, reasonCode: 'duplicate_in_qbo', entityRef: `proposal:${proposalId}`, detail: '6190' });
      return { status: 'duplicate' };
    }
    // Unknown outcome (timeout) → replay-adopt via the existence probe before any retry.
    try {
      const adopt = await deps.connector.detectExisting(txn, p.idempotency_key);
      if (adopt) {
        await recordPosting(tenantId, p, txn, adopt.externalId, adopt.revision, { adoptedAfterTimeout: true }, adopt.raw);
        return { status: 'posted', postingId: -1, qboId: adopt.externalId };
      }
    } catch {
      /* fall through to exception */
    }
    await raiseException({ tenantId, reasonCode: 'qbo_api_error', entityRef: `proposal:${proposalId}`, detail: String(err?.message ?? err) });
    throw err;
  }

  // --- Attach PDF (retry attach only on failure; never re-create) ---
  if (p.attachment_id) {
    const pdf = await deps.loadPdf(p.attachment_id);
    if (pdf) {
      try {
        await deps.connector.attachDocument(created.externalId, pdf, `invoice-${created.externalId}.pdf`);
      } catch (err) {
        await raiseException({ tenantId, reasonCode: 'attachment_failed', entityRef: `posting:${created.externalId}`, detail: String(err) });
      }
    }
  }

  // --- Read-back verify (authoritative; through the connector; no retry on mismatch) ---
  const verified = await deps.connector.readBackVerify(txn, created.externalId);
  const readBack = verified.raw;
  // Amount/DocNumber mismatch is fully authoritative — hold, never mark posted.
  if (verified.verify === 'mismatch' && (verified.reason === 'amount' || verified.reason === 'docnumber')) {
    await recordPosting(tenantId, p, txnType, created.externalId, created.revision, { verifyMismatch: verified.reason }, readBack, 'verify_mismatch');
    await raiseException({ tenantId, reasonCode: 'verify_mismatch', entityRef: `posting:${created.externalId}`, detail: 'read-back mismatch' });
    return { status: 'held', reason: 'verify_mismatch' };
  }
  // F5: an approved+written dimension the provider dropped/altered → unverified + a
  // dedicated dimension_mismatch exception.
  if (verified.verify === 'mismatch' && verified.reason === 'dimension') {
    await recordPosting(tenantId, p, txnType, created.externalId, created.revision, { dimensionMismatch: verified.detail }, readBack, 'dimension_mismatch');
    await raiseException({ tenantId, reasonCode: 'dimension_mismatch', entityRef: `posting:${created.externalId}`, detail: JSON.stringify(verified.detail) });
    return { status: 'held', reason: 'dimension_mismatch' };
  }

  const postingId = await recordPosting(tenantId, p, txnType, created.externalId, created.revision, txn, readBack, 'posted_sandbox');
  await query('UPDATE proposals SET status=$2 WHERE id=$1', [proposalId, 'posted_sandbox']);
  await query(
    `INSERT INTO reconciliation (tenant_id, kind, left_ref, right_ref, match_status, variance)
     VALUES ($1,'proposal_vs_created',$2,$3,'matched',$4)`,
    [tenantId, `proposal:${proposalId}`, `qbo:${created.externalId}`, JSON.stringify({ diffHash: hashOf(readBack) })],
  );
  await writeAudit({
    tenantId,
    action: 'post.sandbox',
    entity: `posting:${postingId}`,
    realm: deps.connector.companyId,
    afterHash: hashOf(readBack),
    detail: { qboId: created.externalId, txnType },
  });

  // --- AuditProof anchor (A1-P2.2): anchor failure NEVER re-creates the txn ---
  // Skipped when SwarmSync is disabled (no outbound anchor call).
  if (deps.swarmSyncEnabled !== false && !(await hasProofRef(tenantId, 'posting', String(postingId), 'auditproof'))) {
    try {
      const v = await deps.anchor({
        realm: deps.connector.companyId,
        qbo_id: created.externalId,
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

  return { status: 'posted', postingId, qboId: created.externalId };
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

export async function postSandboxHandler(job: { data: PostJob }): Promise<void> {
  const { config, swarmSyncMode } = await import('../config.js');
  // F4: the ONLY live accounting path is the provider-neutral connector — never
  // import a provider write module (e.g. qbo/write.js) directly here.
  const { getQboConnector } = await import('../connectors/factory.js');
  const { swarmsync } = await import('../services.js');
  const { loadAttachmentBytes } = await import('../ingest/repo.js');
  const cfg = config();

  // The sole live accounting path: the provider-neutral connector (wraps the QBO clients
  // via the factory — delegation only; the pipeline imports no provider write module).
  const connector = await getQboConnector(job.data.tenantId);
  const expectedCompanyName = (cfg.QBO_SANDBOX_COMPANY_NAME ?? '').trim() || undefined;

  await postOnce(job.data.tenantId, job.data.proposalId, {
    connector,
    anchor: (output) => swarmsync().auditProof(output),
    loadPdf: async (attachmentId) => {
      const sha = (await query<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id=$1', [attachmentId])).rows[0]?.sha256;
      return sha ? loadAttachmentBytes(sha) : null;
    },
    amountCeiling: cfg.AMOUNT_CEILING,
    autoThreshold: cfg.AUTO_THRESHOLD,
    expectedCompanyName,
    swarmSyncEnabled: cfg.SWARMSYNC_ENABLED,
    swarmSyncMode: swarmSyncMode(cfg),
  });
}
