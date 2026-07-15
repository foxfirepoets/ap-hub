import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { query } from '../src/db/pool.js';
import { recordProofRef } from '../src/swarmsync/proof.js';
import { applyDecisions } from '../src/services/review/apply-decisions.js';
import type { ActorContext } from '../src/services/index.js';
import type { QboWriteClient } from '../src/qbo/write.js';
import type { PostDeps } from '../src/pipeline/posting.js';
import {
  resetTables, createTenant, insertMessage, insertAttachment, insertExtraction, countRows, closeAll,
} from './helpers.js';

/**
 * CHUNK_8_REVIEWDASH — apply-decisions.ts: the ONLY write path is through
 * approveProposal/rejectProposal (guarantee 1). Covers: happy path (one posting +
 * one audit row), idempotent replay (zero additional postings), approved-only
 * application, missing-proof hold (fail-safe, guarantee 5), and cross-tenant id
 * skip (never applied under the wrong tenant).
 */

function mockWriter(overrides: Partial<QboWriteClient> = {}): QboWriteClient {
  return {
    realm: 'sandbox-realm',
    createEntity: vi.fn().mockResolvedValue({ id: 'q1', syncToken: '0', entity: { Id: 'q1' } }),
    readEntity: vi.fn().mockResolvedValue({ TotalAmt: 100, DocNumber: 'INV-1' }),
    queryExisting: vi.fn().mockResolvedValue([]),
    attach: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as QboWriteClient;
}
const okAnchor = vi.fn().mockResolvedValue({ proof_id: 'ap1', chain_hash: 'ch1', verification_status: 'passed', confidence: 1, raw: {} });
const postDeps = (writer: QboWriteClient): PostDeps => ({ writer, anchor: okAnchor, loadPdf: async () => Buffer.from('%PDF'), amountCeiling: 10000, autoThreshold: 0.9 });

async function seedProposal(t: number, opts: { status?: string; withProofs?: boolean } = {}): Promise<number> {
  const withProofs = opts.withProofs ?? true;
  const m = await insertMessage(t);
  const a = await insertAttachment(t, m, { sha256: `sha-${t}-${Math.floor(performance.now() * 1000)}` });
  const sha = (await query<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id=$1', [a])).rows[0]!.sha256;
  const e = await insertExtraction(t, m, a, {}, 0.95);
  if (withProofs) await recordProofRef({ tenantId: t, entityKind: 'extraction', entityId: String(e), product: 'verify_api', proofId: 'p', chainHash: 'h' });
  const txn = { txnType: 'Bill', vendorRef: { value: 'V1', name: 'Acme' }, DocNumber: 'INV-1', TxnDate: '2026-07-01', TotalAmt: 100, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }], tax: 0 };
  const pid = (
    await query<{ id: number }>(
      `INSERT INTO proposals (tenant_id, attachment_id, extraction_id, proposed_txn, idempotency_key, confidence, status, flags)
       VALUES ($1,$2,$3,$4,$5,0.95,$6,'{}') RETURNING id`,
      [t, a, e, JSON.stringify(txn), sha, opts.status ?? 'ready'],
    )
  ).rows[0]!.id;
  if (withProofs) await recordProofRef({ tenantId: t, entityKind: 'proposal', entityId: String(pid), product: 'invoiceproof', verdict: 'clean' });
  return pid;
}

const ctxFor = (t: number): ActorContext => ({ userId: 0, tenantId: t, role: 'owner_controller', actor: 'cli:test' });
const humanAudit = (t: number, action: string) =>
  countRows('audit_log', "tenant_id=$1 AND action=$2 AND actor<>'system'", [t, action]);

describe('CHUNK_8_REVIEWDASH — apply-decisions', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('one approved item -> exactly one sandbox posting + one audit_log row', async () => {
    const t = await createTenant();
    const pid = await seedProposal(t);
    const w = mockWriter();
    const res = await applyDecisions(ctxFor(t), { decisions: [{ id: pid, decision: 'approved' }] }, postDeps(w));
    expect(res).toEqual({ approved_posted: 1, approved_held: 0, rejected: 0, skipped: 0, errors: [] });
    expect(await countRows('postings', "tenant_id=$1 AND status='posted_sandbox'", [t])).toBe(1);
    expect(await humanAudit(t, 'proposal.approve')).toBe(1);
  });

  it('re-running the SAME decisions file -> zero additional postings (idempotent, guarantee 4)', async () => {
    const t = await createTenant();
    const pid = await seedProposal(t);
    const file = { decisions: [{ id: pid, decision: 'approved' as const }] };
    const w1 = mockWriter();
    await applyDecisions(ctxFor(t), file, postDeps(w1));
    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(1);

    const w2 = mockWriter();
    const res2 = await applyDecisions(ctxFor(t), file, postDeps(w2));
    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(1); // zero additional
    expect(w2.createEntity).not.toHaveBeenCalled();
    expect(res2.errors).toEqual([]); // already-posted is not an error
  });

  it('rejected -> proposal rejected, no posting; pending/unknown -> skipped, no write', async () => {
    const t = await createTenant();
    const pidReject = await seedProposal(t, { status: 'review' });
    const pidPending = await seedProposal(t, { status: 'review' });
    const pidUnknown = await seedProposal(t, { status: 'review' });
    const res = await applyDecisions(ctxFor(t), {
      decisions: [
        { id: pidReject, decision: 'rejected' },
        { id: pidPending, decision: 'pending' },
        { id: pidUnknown, decision: 'something-else' as never },
      ],
    }, postDeps(mockWriter()));
    expect(res.rejected).toBe(1);
    expect(res.skipped).toBe(2);
    expect(res.approved_posted).toBe(0);
    expect(await countRows('proposals', "id=$1 AND status='rejected'", [pidReject])).toBe(1);
    expect(await countRows('proposals', "id=$1 AND status='review'", [pidPending])).toBe(1);
    expect(await countRows('proposals', "id=$1 AND status='review'", [pidUnknown])).toBe(1);
    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(0);
  });

  it('an approved item lacking proof coverage -> held, never posted; surfaced as an error (guarantee 5, fail-safe)', async () => {
    const t = await createTenant();
    const pid = await seedProposal(t, { withProofs: false });
    const res = await applyDecisions(ctxFor(t), { decisions: [{ id: pid, decision: 'approved' }] }, postDeps(mockWriter()));
    expect(res.approved_posted).toBe(0);
    expect(res.approved_held).toBe(1);
    expect(res.errors).toEqual([{ id: pid, reason: 'missing_proof_coverage' }]);
    expect(await countRows('postings', 'tenant_id=$1', [t])).toBe(0);
  });

  it('a decision id belonging to another tenant is skipped, never applied (cross-tenant safety)', async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const pidA = await seedProposal(tenantA);
    const res = await applyDecisions(ctxFor(tenantB), { decisions: [{ id: pidA, decision: 'approved' }] }, postDeps(mockWriter()));
    expect(res.skipped).toBe(1);
    expect(res.approved_posted).toBe(0);
    expect(await countRows('postings', 'tenant_id=$1', [tenantA])).toBe(0);
    expect(await countRows('proposals', "id=$1 AND status='ready'", [pidA])).toBe(1); // untouched
  });

  it('an invalid id (non-integer / non-positive) is skipped, never resolved', async () => {
    const t = await createTenant();
    const res = await applyDecisions(ctxFor(t), {
      decisions: [
        { id: 0, decision: 'approved' },
        { id: -5, decision: 'approved' },
        { id: 1.5 as unknown as number, decision: 'approved' },
      ],
    }, postDeps(mockWriter()));
    expect(res.skipped).toBe(3);
    expect(res.approved_posted).toBe(0);
  });
});
