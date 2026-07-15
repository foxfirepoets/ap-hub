import { scopedQuery } from '../../db/scoped.js';
import { isValidId } from '../index.js';
import { sandboxLink } from './http.js';

/**
 * CHUNK_3_READ — the transaction list. Projects each proposal into a UX status
 * (prepared / held / posted / reconciled / rejected / exception), attaching the
 * QBO sandbox link once posted. Read-only, tenant-scoped; `getTransactionById`
 * returns null for a cross-tenant id → 404.
 */

export type UxStatus = 'prepared' | 'held' | 'posted' | 'reconciled' | 'rejected' | 'exception';

export interface TransactionRow {
  proposalId: number;
  status: UxStatus;
  rawStatus: string;
  confidence: number;
  vendor: string | null;
  total: string | null;
  docNumber: string | null;
  txnDate: string | null;
  postingId: number | null;
  qboType: string | null;
  qboId: string | null;
  qboLink: string | null;
  reconciled: boolean;
  createdAt: string;
}

interface TxnDbRow {
  proposal_id: number;
  raw_status: string;
  confidence: string;
  proposed_txn: Record<string, unknown> | null;
  posting_id: number | null;
  qbo_type: string | null;
  qbo_id: string | null;
  realm: string | null;
  reconciled: boolean;
  created_at: Date;
}

/** UX status: `reconciled` overrides `posted`; otherwise map the proposal status. */
function uxStatus(rawStatus: string, reconciled: boolean): UxStatus {
  if (rawStatus === 'posted_sandbox') return reconciled ? 'reconciled' : 'posted';
  if (rawStatus === 'ready') return 'prepared';
  if (rawStatus === 'review') return 'held';
  if (rawStatus === 'rejected') return 'rejected';
  return 'exception';
}

function mapRow(r: TxnDbRow): TransactionRow {
  const txn = (r.proposed_txn ?? {}) as Record<string, unknown>;
  const vendorRef = (txn.vendorRef ?? null) as { name?: string } | null;
  const qboLink =
    r.qbo_type && r.qbo_id && r.realm ? sandboxLink(r.realm, r.qbo_type, r.qbo_id) : null;
  return {
    proposalId: r.proposal_id,
    status: uxStatus(r.raw_status, r.reconciled),
    rawStatus: r.raw_status,
    confidence: Number(r.confidence),
    vendor: vendorRef?.name ?? null,
    total: txn.TotalAmt != null ? String(txn.TotalAmt) : null,
    docNumber: txn.DocNumber != null ? String(txn.DocNumber) : null,
    txnDate: txn.TxnDate != null ? String(txn.TxnDate) : null,
    postingId: r.posting_id,
    qboType: r.qbo_type,
    qboId: r.qbo_id,
    qboLink,
    reconciled: r.reconciled,
    createdAt: r.created_at.toISOString(),
  };
}

// The posting/reconciliation joins are scalar sub-selects so one proposal yields one row.
const BASE_SELECT = `
  SELECT
    p.id                AS proposal_id,
    p.status            AS raw_status,
    p.confidence,
    p.proposed_txn,
    po.id               AS posting_id,
    po.qbo_type,
    po.qbo_id,
    po.realm,
    EXISTS (
      SELECT 1 FROM reconciliation rc
       WHERE rc.tenant_id = p.tenant_id
         AND rc.left_ref = 'proposal:' || p.id
         AND rc.match_status = 'matched'
    )                   AS reconciled,
    p.created_at
  FROM proposals p
  LEFT JOIN LATERAL (
    SELECT id, qbo_type, qbo_id, realm
      FROM postings
     WHERE tenant_id = p.tenant_id AND proposal_id = p.id AND status = 'posted_sandbox'
     ORDER BY id DESC LIMIT 1
  ) po ON true`;

export async function listTransactions(
  tenantId: number,
  opts: { status?: UxStatus; limit?: number } = {},
): Promise<TransactionRow[]> {
  const { rows } = await scopedQuery<TxnDbRow>(
    tenantId,
    `${BASE_SELECT} WHERE p.tenant_id = $1 ORDER BY p.created_at DESC LIMIT $2`,
    [opts.limit ?? 200],
  );
  const mapped = rows.map(mapRow);
  return opts.status ? mapped.filter((t) => t.status === opts.status) : mapped;
}

export async function getTransactionById(tenantId: number, id: number): Promise<TransactionRow | null> {
  if (!isValidId(id)) return null;
  const { rows } = await scopedQuery<TxnDbRow>(
    tenantId,
    `${BASE_SELECT} WHERE p.tenant_id = $1 AND p.id = $2`,
    [id],
  );
  const r = rows[0];
  return r ? mapRow(r) : null;
}
