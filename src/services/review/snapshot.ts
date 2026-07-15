import { scopedQuery } from '../../db/scoped.js';
import { redact } from '../../logger.js';

/**
 * CHUNK_8_REVIEWDASH — read-only, tenant-scoped snapshot of a tenant's reviewable
 * proposals (review/ready/exception), shaped for the offline reviewer dashboard
 * generator. Reuses the existing tenant-scoped query helper (`scopedQuery`) so a
 * foreign tenant's proposal can never appear — same guarantee as the read layer
 * (CHUNK_3_READ). Amounts are integer minor units derived from `proposed_txn`; the
 * whole snapshot is passed through `redact()` (src/logger.ts) before being returned,
 * so nothing token/secret-shaped (per the shared redaction rules) can leak into the
 * artifact even if it slipped into a filename/subject/vendor string upstream.
 */

export type ReviewRisk = 'high' | 'med' | 'low';
export type ReviewStatus = 'review' | 'ready' | 'exception';

export interface ReviewProof {
  product: string;
  verdict: string;
}

export interface ReviewProposal {
  id: number;
  vendor: string;
  amount_cents: number;
  risk: ReviewRisk;
  issue: string;
  source: string;
  status: ReviewStatus;
  proof: ReviewProof | null;
}

export interface ReviewVendorTotal {
  vendor: string;
  count: number;
  amount_cents: number;
}

export interface ReviewSummary {
  count: number;
  ready: number;
  review: number;
  exception: number;
  amount_cents: number;
}

export interface ReviewSnapshot {
  run: string;
  tenant: number;
  company: string;
  generated: string;
  proposals: ReviewProposal[];
  vendorTotals: ReviewVendorTotal[];
  summary: ReviewSummary;
}

export interface SnapshotDeps {
  reviewThreshold: number;
  company: string;
  runId?: string;
}

/** Real config-backed deps (mirrors `defaultPostDeps` in services/approve.ts). */
export async function defaultSnapshotDeps(): Promise<SnapshotDeps> {
  const { config } = await import('../../config.js');
  const cfg = config();
  return { reviewThreshold: cfg.REVIEW_THRESHOLD, company: cfg.QBO_SANDBOX_COMPANY_NAME };
}

/**
 * Open Question 1 default (spec §14): any critical/bank-change flag → high;
 * confidence below REVIEW_THRESHOLD → med; else low. Reuses the SAME reason-code
 * vocabulary the severity classifier / gatekeeper / digest already use for
 * "material risk" (`bank_change_warning`, `duplicate` = critical-tier;
 * `fraud_flag` = high-tier) — no new severity taxonomy invented.
 */
const HIGH_RISK_FLAGS = new Set(['bank_change_warning', 'duplicate', 'fraud_flag']);

export function deriveRisk(flags: string[], confidence: number, reviewThreshold: number): ReviewRisk {
  if ((flags ?? []).some((f) => HIGH_RISK_FLAGS.has(f))) return 'high';
  if (confidence < reviewThreshold) return 'med';
  return 'low';
}

function issueLabel(status: ReviewStatus, flags: string[]): string {
  const first = (flags ?? [])[0];
  if (first) return first.replace(/_/g, ' ');
  if (status === 'exception') return 'exception';
  if (status === 'review') return 'needs review';
  return 'ready';
}

interface SnapshotDbRow {
  id: number;
  status: string;
  confidence: string;
  flags: string[];
  proposed_txn: Record<string, unknown> | null;
  source_filename: string | null;
  email_subject: string | null;
  proof_product: string | null;
  proof_verdict: string | null;
}

function mapRow(r: SnapshotDbRow, reviewThreshold: number): ReviewProposal {
  const txn = (r.proposed_txn ?? {}) as Record<string, unknown>;
  const vendorRef = (txn.vendorRef ?? null) as { name?: string } | null;
  const vendor = vendorRef?.name ?? 'Unknown vendor';
  const totalAmt = Number(txn.TotalAmt ?? 0);
  const amount_cents = Number.isFinite(totalAmt) ? Math.round(totalAmt * 100) : 0;
  const confidence = Number(r.confidence);
  const flags = r.flags ?? [];
  const status = r.status as ReviewStatus;
  return {
    id: r.id,
    vendor,
    amount_cents,
    risk: deriveRisk(flags, confidence, reviewThreshold),
    issue: issueLabel(status, flags),
    source: r.source_filename ?? r.email_subject ?? 'no source',
    status,
    proof: r.proof_product ? { product: r.proof_product, verdict: r.proof_verdict ?? 'unavailable' } : null,
  };
}

function makeRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

export async function buildReviewSnapshot(tenantId: number, deps?: SnapshotDeps): Promise<ReviewSnapshot> {
  const d = deps ?? (await defaultSnapshotDeps());
  const { rows } = await scopedQuery<SnapshotDbRow>(
    tenantId,
    `SELECT
       p.id, p.status, p.confidence, p.flags, p.proposed_txn,
       a.filename AS source_filename,
       m.subject  AS email_subject,
       pr.product AS proof_product,
       pr.verdict AS proof_verdict
     FROM proposals p
     LEFT JOIN attachments a ON a.id = p.attachment_id
     LEFT JOIN extractions e ON e.id = p.extraction_id
     LEFT JOIN messages m ON m.id = e.message_id
     LEFT JOIN proof_refs pr
       ON pr.tenant_id = p.tenant_id AND pr.entity_kind = 'proposal'
      AND pr.entity_id = p.id::text AND pr.product = 'invoiceproof'
     WHERE p.tenant_id = $1 AND p.status IN ('review','ready','exception')
     ORDER BY p.id ASC`,
    [],
  );

  const proposals = rows.map((r) => mapRow(r, d.reviewThreshold));

  const totalsByVendor = new Map<string, ReviewVendorTotal>();
  for (const p of proposals) {
    const t = totalsByVendor.get(p.vendor) ?? { vendor: p.vendor, count: 0, amount_cents: 0 };
    t.count += 1;
    t.amount_cents += p.amount_cents;
    totalsByVendor.set(p.vendor, t);
  }

  const summary: ReviewSummary = {
    count: proposals.length,
    ready: proposals.filter((p) => p.status === 'ready').length,
    review: proposals.filter((p) => p.status === 'review').length,
    exception: proposals.filter((p) => p.status === 'exception').length,
    amount_cents: proposals.reduce((sum, p) => sum + p.amount_cents, 0),
  };

  const snapshot: ReviewSnapshot = {
    run: d.runId ?? makeRunId(),
    tenant: tenantId,
    company: d.company,
    generated: new Date().toISOString(),
    proposals,
    vendorTotals: [...totalsByVendor.values()],
    summary,
  };

  return redact(snapshot) as ReviewSnapshot;
}
