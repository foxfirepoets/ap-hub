import { scopedQuery } from '../../db/scoped.js';

/**
 * CHUNK_3_READ — the Today digest. Counts are derived directly from the tenant's
 * `exceptions` / `proposals` / `postings` rows so a test can recompute the same
 * SELECTs and assert equality (acceptance criterion: counts == SELECT-derived counts).
 * Every query is tenant-scoped through `scopedQuery`.
 */

export interface TodayCounts {
  exceptions: number;
  posted: number;
  held: number;
  failed: number;
}

export interface TodayItem {
  proposalId: number;
  status: string;
  confidence: number;
  vendor: string | null;
  total: string | null;
  docNumber: string | null;
  sourceFilename: string | null;
  emailSubject: string | null;
  createdAt: string;
}

export interface TodayDigest {
  tenantId: number;
  generatedAt: string;
  counts: TodayCounts;
  items: TodayItem[];
}

const DEFAULT_ITEM_LIMIT = 100;

export async function getTodayCounts(tenantId: number): Promise<TodayCounts> {
  const { rows } = await scopedQuery<{
    exceptions: number;
    posted: number;
    held: number;
    failed: number;
  }>(
    tenantId,
    `SELECT
       (SELECT count(*)::int FROM exceptions WHERE tenant_id = $1 AND status = 'open')            AS exceptions,
       (SELECT count(*)::int FROM postings   WHERE tenant_id = $1 AND status IN ('posted_sandbox','posted'))  AS posted,
       (SELECT count(*)::int FROM proposals  WHERE tenant_id = $1 AND status = 'review')          AS held,
       (SELECT count(*)::int FROM proposals  WHERE tenant_id = $1 AND status = 'exception')       AS failed`,
  );
  const r = rows[0];
  return {
    exceptions: r?.exceptions ?? 0,
    posted: r?.posted ?? 0,
    held: r?.held ?? 0,
    failed: r?.failed ?? 0,
  };
}

export async function getTodayItems(tenantId: number, limit = DEFAULT_ITEM_LIMIT): Promise<TodayItem[]> {
  const { rows } = await scopedQuery<{
    proposal_id: number;
    status: string;
    confidence: string;
    proposed_txn: Record<string, unknown> | null;
    source_filename: string | null;
    email_subject: string | null;
    created_at: Date;
  }>(
    tenantId,
    `SELECT proposal_id, status, confidence, proposed_txn, source_filename, email_subject, created_at
       FROM v_proposal_review
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [limit],
  );
  return rows.map((r) => {
    const txn = (r.proposed_txn ?? {}) as Record<string, unknown>;
    const vendorRef = (txn.vendorRef ?? null) as { name?: string } | null;
    return {
      proposalId: r.proposal_id,
      status: r.status,
      confidence: Number(r.confidence),
      vendor: vendorRef?.name ?? null,
      total: txn.TotalAmt != null ? String(txn.TotalAmt) : null,
      docNumber: txn.DocNumber != null ? String(txn.DocNumber) : null,
      sourceFilename: r.source_filename,
      emailSubject: r.email_subject,
      createdAt: r.created_at.toISOString(),
    };
  });
}

export async function getToday(tenantId: number, limit = DEFAULT_ITEM_LIMIT): Promise<TodayDigest> {
  const [counts, items] = await Promise.all([getTodayCounts(tenantId), getTodayItems(tenantId, limit)]);
  return { tenantId, generatedAt: new Date().toISOString(), counts, items };
}
