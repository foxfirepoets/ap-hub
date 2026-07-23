import { query } from '../db/pool.js';
import { JOBS } from '../queue.js';
import {
  resolveVendor,
  resolveAccount,
  routeTxnType,
  type VendorCandidate,
  type AccountCandidate,
} from '../mapping/resolve.js';
import { classifyFindings } from '../swarmsync/severity.js';
import { raiseException } from '../exceptions.js';
import { recordProofRef, hasProofRef } from '../swarmsync/proof.js';
import { writeAudit } from '../audit.js';
import { logger } from '../logger.js';
import type { InvoiceScanInput, InvoiceScanResult } from '../swarmsync/client.js';
import type { SwarmSyncMode } from '../config.js';
import type { ExtractionResult } from '../extract/schema.js';

export interface MapJob {
  tenantId: number;
  extractionId: number;
  attachmentId: number | null;
  messageId: number;
}

/** map job simply forwards to propose — resolution + gating happen together. */
export async function mapHandler(job: { data: MapJob }): Promise<void> {
  const { getQueue } = await import('../queue.js');
  await getQueue().send(JOBS.propose, job.data);
}

export interface ProposeDeps {
  scan: (input: InvoiceScanInput) => Promise<InvoiceScanResult>;
  autoThreshold: number;
  reviewThreshold: number;
  /** Enqueue the sandbox-posting job for a ready proposal. Omit in tests. */
  enqueuePost?: (proposalId: number) => Promise<void>;
  /**
   * SwarmSync mode (default 'on'). 'on' = InvoiceProof scan + proof-gated ready.
   * 'off_review' = no scan, cap at review (human approves). 'off_autopost' = no
   * scan, allow ready/post with no fraud gate (operator's explicit choice).
   */
  swarmSync?: SwarmSyncMode;
}

export interface ProposeOutcome {
  proposalId: number;
  status: 'ready' | 'review' | 'exception';
}

export async function proposeOnce(
  tenantId: number,
  job: MapJob,
  deps: ProposeDeps,
): Promise<ProposeOutcome | null> {
  const ext = (
    await query<{ id: number; attachment_id: number | null; fields: ExtractionResult; confidence: string }>(
      'SELECT id, attachment_id, fields, confidence FROM extractions WHERE tenant_id=$1 AND id=$2',
      [tenantId, job.extractionId],
    )
  ).rows[0];
  if (!ext) return null;
  const fields = ext.fields;
  const flags = new Set<string>(fields.flags ?? []);

  const sha = job.attachmentId
    ? (
        await query<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id=$1', [job.attachmentId])
      ).rows[0]?.sha256 ?? null
    : null;

  // --- Vendor resolution ---
  const vendorCands = (
    await query<{ source_key: string; target_qbo_id: string | null; target_name: string | null }>(
      "SELECT source_key, target_qbo_id, target_name FROM mappings WHERE tenant_id=$1 AND kind='vendor'",
      [tenantId],
    )
  ).rows.map<VendorCandidate>((r) => ({
    sourceKey: r.source_key,
    targetId: r.target_qbo_id ?? '',
    targetName: r.target_name ?? r.source_key,
  }));

  const vendor = resolveVendor(fields.vendor_name, null, vendorCands);
  if (vendor.status === 'unknown') {
    flags.add('unknown_vendor');
    await raiseException({ tenantId, reasonCode: 'unknown_vendor', entityRef: `extraction:${ext.id}` });
  }

  // --- Account resolution ---
  const acctCands = (
    await query<{ source_key: string; target_qbo_id: string | null; target_name: string | null }>(
      "SELECT source_key, target_qbo_id, target_name FROM mappings WHERE tenant_id=$1 AND kind='account'",
      [tenantId],
    )
  ).rows.map<AccountCandidate>((r) => ({
    key: r.source_key,
    targetId: r.target_qbo_id ?? '',
    targetName: r.target_name ?? r.source_key,
  }));
  const account = resolveAccount(
    fields.account_hint ?? null,
    (fields.line_items ?? []).map((li) => li.description),
    acctCands,
  );
  if (!account && fields.doc_type === 'invoice') {
    flags.add('unmapped_account');
    await raiseException({ tenantId, reasonCode: 'unmapped_account', entityRef: `extraction:${ext.id}` });
  }

  const paidNow = fields.doc_type === 'receipt';
  const txnType = routeTxnType(fields.doc_type, fields.direction, paidNow);

  const proposedTxn = {
    txnType,
    vendorRef: vendor.status !== 'unknown' ? { value: vendor.targetId, name: vendor.targetName } : null,
    DocNumber: fields.invoice_number,
    TxnDate: fields.invoice_date,
    DueDate: fields.due_date,
    TotalAmt: fields.total,
    lines: (fields.line_items ?? []).map((li) => ({
      Amount: li.amount,
      description: li.description,
      accountRef: account ? { value: account.targetId, name: account.targetName } : null,
    })),
    tax: fields.tax,
  };

  // --- InvoiceProof scan (Amendment A1) — BEFORE status assignment ---
  const vendorMaster = vendorCands.map((c) => ({ vendorName: c.targetName }));
  const paymentHistory = (
    await query<{ fields: any }>(
      `SELECT fields FROM extractions WHERE tenant_id=$1 AND id<>$2 ORDER BY id DESC LIMIT 200`,
      [tenantId, ext.id],
    )
  ).rows.map((r) => ({
    invoiceNo: r.fields?.invoice_number,
    vendor: r.fields?.vendor_name,
    amount: r.fields?.total,
  }));

  const mode: SwarmSyncMode = deps.swarmSync ?? 'on';
  let scanFailed = false;
  let findings: InvoiceScanResult['findings'] = [];
  if (mode === 'on') {
   try {
    const scanRes = await deps.scan({
      invoices: [
        {
          vendor: fields.vendor_name,
          invoiceNo: fields.invoice_number,
          amount: fields.total,
          tax: fields.tax,
          lineItemsTotal: (fields.line_items ?? []).reduce((a, li) => a + (li.amount ?? 0), 0),
          bank: fields.bank_info ?? undefined,
          po: fields.job_ref ?? undefined,
        },
      ],
      vendorMaster,
      paymentHistory,
    });
    findings = scanRes.findings;
  } catch (err) {
    scanFailed = true;
    logger.warn({ err: String(err), extractionId: ext.id }, 'invoiceproof scan failed');
    flags.add('proof_scan_unavailable');
    await raiseException({
      tenantId,
      reasonCode: 'proof_scan_unavailable',
      entityRef: `extraction:${ext.id}`,
      detail: `InvoiceProof scan failed: ${(err as Error).message}`,
    });
   }
  }

  const cls = classifyFindings(findings);
  if (cls.hasCritical) {
    const reason = cls.criticalReason ?? 'duplicate';
    flags.add(reason);
    await raiseException({ tenantId, reasonCode: reason, entityRef: `extraction:${ext.id}`, detail: cls.evidence });
  } else if (cls.hasHigh) {
    flags.add('fraud_flag');
    await raiseException({ tenantId, reasonCode: 'fraud_flag', entityRef: `extraction:${ext.id}`, detail: cls.evidence });
  } else if (cls.hasMedium) {
    flags.add('round_dollar');
  }

  const confidence = Math.min(
    Number(ext.confidence),
    vendor.status === 'exact' ? 1 : vendor.status === 'fuzzy' ? vendor.confidence : 0.5,
  );

  // --- Status assignment with the never-ready-without-both-proofs invariant ---
  // When SwarmSync is ON, 'ready' requires both proofs and a clean scan. When it
  // is OFF, there are no proofs: 'off_autopost' treats proofs as satisfied (no
  // fraud gate), 'off_review' never reaches ready so a human reviews.
  const hasVerify = mode === 'on' ? await hasProofRef(tenantId, 'extraction', String(ext.id), 'verify_api') : false;
  const hasInvoiceProof = mode === 'on' ? !scanFailed : false;
  const proofsSatisfied =
    mode === 'on'
      ? hasVerify && hasInvoiceProof && !flags.has('proof_scan_unavailable')
      : mode === 'off_autopost';
  const blockingFlags = ['total_mismatch', 'bank_change_warning', 'duplicate', 'unknown_vendor', 'unmapped_account', 'unmapped_dimension'];
  const hasBlocking = [...flags].some((f) => blockingFlags.includes(f));
  const hasHighOrCritical = cls.hasCritical || cls.hasHigh;

  let status: 'ready' | 'review' | 'exception';
  if (hasBlocking || cls.hasCritical) {
    status = 'exception';
  } else if (
    confidence >= deps.autoThreshold &&
    proofsSatisfied &&
    !hasHighOrCritical
  ) {
    status = 'ready';
  } else if (confidence >= deps.reviewThreshold) {
    status = 'review';
  } else {
    status = 'exception';
    flags.add('low_confidence');
    await raiseException({ tenantId, reasonCode: 'low_confidence', entityRef: `extraction:${ext.id}` });
  }

  const proposalId = (
    await query<{ id: number }>(
      `INSERT INTO proposals (tenant_id, attachment_id, extraction_id, proposed_txn, idempotency_key, confidence, status, flags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id, attachment_id) DO UPDATE SET
         proposed_txn=EXCLUDED.proposed_txn, confidence=EXCLUDED.confidence,
         status=EXCLUDED.status, flags=EXCLUDED.flags
       RETURNING id`,
      [
        tenantId,
        job.attachmentId,
        ext.id,
        JSON.stringify(proposedTxn),
        sha,
        confidence,
        status,
        [...flags],
      ],
    )
  ).rows[0]!.id;

  if (mode === 'on' && !scanFailed) {
    await recordProofRef({
      tenantId,
      entityKind: 'proposal',
      entityId: String(proposalId),
      product: 'invoiceproof',
      findings,
      verdict: cls.hasCritical ? 'critical' : cls.hasHigh ? 'high' : 'clean',
    });
  }

  await writeAudit({
    tenantId,
    action: 'propose.done',
    entity: `proposal:${proposalId}`,
    detail: { status, vendor: vendor.status },
  });

  if (status === 'ready' && deps.enqueuePost) {
    await deps.enqueuePost(proposalId);
  }

  return { proposalId, status };
}

export async function proposeHandler(job: { data: MapJob }): Promise<void> {
  const { config, swarmSyncMode } = await import('../config.js');
  const { swarmsync } = await import('../services.js');
  const cfg = config();
  await proposeOnce(job.data.tenantId, job.data, {
    scan: (input) => swarmsync().scanInvoices(input),
    swarmSync: swarmSyncMode(cfg),
    autoThreshold: cfg.AUTO_THRESHOLD,
    reviewThreshold: cfg.REVIEW_THRESHOLD,
    enqueuePost: async (proposalId) => {
      const { getQueue } = await import('../queue.js');
      await getQueue().send(JOBS.post_sandbox, { tenantId: job.data.tenantId, proposalId });
    },
  });
}
