import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { postOnce } from '../src/pipeline/posting.js';
import { query } from '../src/db/pool.js';
import { recordProofRef, hasProofRef } from '../src/swarmsync/proof.js';
import {
  resetTables, createTenant, insertMessage, insertAttachment, insertExtraction, countRows, closeAll,
} from './helpers.js';
import { mockConnector } from './connector-mock.js';
import type { AccountingConnector } from '../src/connectors/types.js';

// F4: the posting path now runs through the provider-neutral connector; the mock mirrors
// the old writer mock 1:1 so every guarantee assertion below is preserved.
const mockWriter = mockConnector;
const okAnchor = vi.fn().mockResolvedValue({ proof_id: 'ap1', chain_hash: 'ch1', verification_status: 'passed', confidence: 1, raw: {} });
const loadPdf = async () => Buffer.from('%PDF');

async function seedReadyProposal(t: number, opts: { status?: string; total?: number } = {}) {
  const m = await insertMessage(t);
  const a = await insertAttachment(t, m, { sha256: `sha-${t}-${Math.floor(performance.now())}` });
  const sha = (await query<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id=$1', [a])).rows[0]!.sha256;
  const e = await insertExtraction(t, m, a, {}, 0.95);
  await recordProofRef({ tenantId: t, entityKind: 'extraction', entityId: String(e), product: 'verify_api', proofId: 'p', chainHash: 'h' });
  const txn = { txnType: 'Bill', vendorRef: { value: 'V1', name: 'Acme' }, DocNumber: 'INV-1', TxnDate: '2026-07-01', TotalAmt: opts.total ?? 100, lines: [{ Amount: opts.total ?? 100, description: 'work', accountRef: { value: '60' } }], tax: 0 };
  const pid = (
    await query<{ id: number }>(
      `INSERT INTO proposals (tenant_id, attachment_id, extraction_id, proposed_txn, idempotency_key, confidence, status, flags)
       VALUES ($1,$2,$3,$4,$5,0.95,$6,'{}') RETURNING id`,
      [t, a, e, JSON.stringify(txn), sha, opts.status ?? 'ready'],
    )
  ).rows[0]!.id;
  await recordProofRef({ tenantId: t, entityKind: 'proposal', entityId: String(pid), product: 'invoiceproof', verdict: 'clean' });
  return { proposalId: pid, sha, attachmentId: a, extractionId: e };
}

const deps = (connector: AccountingConnector, anchor = okAnchor) => ({ connector, anchor, loadPdf, amountCeiling: 10000, autoThreshold: 0.9 });

describe('CHUNK_7 posting', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('create_and_verify: creates one sandbox txn, verifies, records posting + reconciliation', async () => {
    const t = await createTenant();
    const { proposalId } = await seedReadyProposal(t);
    const w = mockWriter();
    const out = await postOnce(t, proposalId, deps(w));
    expect(out.status).toBe('posted');
    expect(w.postBill).toHaveBeenCalledTimes(1);
    expect(await countRows('postings', "status='posted_sandbox'")).toBe(1);
    expect(await countRows('proposals', "status='posted_sandbox'")).toBe(1);
    expect(await countRows('reconciliation')).toBe(1);
  });

  it('posting_anchor: records the AuditProof posting anchor', async () => {
    const t = await createTenant();
    const { proposalId } = await seedReadyProposal(t);
    const out = await postOnce(t, proposalId, deps(mockWriter()));
    expect(out.status).toBe('posted');
    const posting = (await query<{ id: number }>('SELECT id FROM postings LIMIT 1')).rows[0]!.id;
    expect(await hasProofRef(t, 'posting', String(posting), 'auditproof')).toBe(true);
  });

  it('posting_anchor failure never re-creates the txn', async () => {
    const t = await createTenant();
    const { proposalId } = await seedReadyProposal(t);
    const w = mockWriter();
    await postOnce(t, proposalId, deps(w, vi.fn().mockRejectedValue(new Error('anchor down'))));
    expect(w.postBill).toHaveBeenCalledTimes(1); // NOT re-created
    expect(await countRows('postings')).toBe(1);
    expect(await countRows('exceptions', "reason_code='proof_scan_unavailable'")).toBe(1);
  });

  it('idempotent_double_post: second run creates zero additional txns', async () => {
    const t = await createTenant();
    const { proposalId } = await seedReadyProposal(t);
    const w = mockWriter();
    await postOnce(t, proposalId, deps(w));
    // Force proposal back to ready to exercise the idempotency layer directly.
    await query('UPDATE proposals SET status=$2 WHERE id=$1', [proposalId, 'ready']);
    const out2 = await postOnce(t, proposalId, deps(w));
    expect(out2.status).toBe('duplicate');
    expect(w.postBill).toHaveBeenCalledTimes(1);
    expect(await countRows('postings')).toBe(1);
  });

  it('replay_after_timeout: create times out but the txn exists → adopt, no duplicate', async () => {
    const t = await createTenant();
    const { proposalId } = await seedReadyProposal(t);
    const w = mockWriter({
      postBill: vi.fn().mockRejectedValue(new Error('network timeout')),
      // Pre-create dedup sees nothing; after the timed-out create, the txn exists -> adopt.
      detectExisting: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ externalId: 'q-existing', revision: '0', raw: { Id: 'q-existing' } }),
    });
    const out = await postOnce(t, proposalId, deps(w));
    expect(out.status).toBe('posted');
    expect((out as any).qboId).toBe('q-existing');
    expect(await countRows('postings')).toBe(1);
  });

  it('gate_holds: a review proposal and an over-ceiling proposal are never created', async () => {
    const t = await createTenant();
    const review = await seedReadyProposal(t, { status: 'review' });
    const w1 = mockWriter();
    expect((await postOnce(t, review.proposalId, deps(w1))).status).toBe('held');
    expect(w1.postBill).not.toHaveBeenCalled();

    const big = await seedReadyProposal(t, { total: 999999 });
    const w2 = mockWriter();
    expect((await postOnce(t, big.proposalId, deps(w2))).status).toBe('held');
    expect(w2.postBill).not.toHaveBeenCalled();
  });

  it('proof_gate_posting: a ready proposal missing a proof ref is never posted', async () => {
    const t = await createTenant();
    const { proposalId } = await seedReadyProposal(t);
    // Remove the invoiceproof proof to simulate missing coverage.
    await query("DELETE FROM proof_refs WHERE tenant_id=$1 AND entity_kind='proposal'", [t]);
    const w = mockWriter();
    const out = await postOnce(t, proposalId, deps(w));
    expect(out.status).toBe('held');
    expect((out as any).reason).toBe('missing_proof_coverage');
    expect(w.postBill).not.toHaveBeenCalled();
  });

  // --- FIX-F5 regression tests ---

  it('due_date_in_payload: a proposal DueDate is carried into the built QBO payload', async () => {
    const t = await createTenant();
    const { proposalId } = await seedReadyProposal(t);
    const row = (await query<{ proposed_txn: any }>('SELECT proposed_txn FROM proposals WHERE id=$1', [proposalId])).rows[0]!;
    const txn = { ...row.proposed_txn, DueDate: '2026-08-15' };
    await query('UPDATE proposals SET proposed_txn=$2 WHERE id=$1', [proposalId, JSON.stringify(txn)]);
    const w = mockWriter();
    const out = await postOnce(t, proposalId, deps(w));
    expect(out.status).toBe('posted');
    const sentTxn = (w.postBill as any).mock.calls[0][0];
    expect(sentTxn.DueDate).toBe('2026-08-15'); // adapter-level payload emission covered in connector-contract.test.ts
  });

  it('dedup_query_failure_holds: a throwing pre-create dedup query holds and never creates', async () => {
    const t = await createTenant();
    const { proposalId } = await seedReadyProposal(t);
    const w = mockWriter({ detectExisting: vi.fn().mockRejectedValue(new Error('qbo query down')) });
    const out = await postOnce(t, proposalId, deps(w));
    expect(out.status).toBe('held');
    expect((out as any).reason).toBe('dedup_unavailable');
    expect(w.postBill).not.toHaveBeenCalled();
    expect(await countRows('exceptions', "reason_code='dedup_unavailable'")).toBe(1);
  });

  it('company_mismatch_holds: a mismatching verifyCompany holds and never creates', async () => {
    const t = await createTenant();
    const { proposalId } = await seedReadyProposal(t);
    const w = mockWriter({ verifyCompanyIdentity: vi.fn().mockResolvedValue('mismatch' as const) });
    const out = await postOnce(t, proposalId, { ...deps(w), expectedCompanyName: 'Sandbox Co' });
    expect(out.status).toBe('held');
    expect((out as any).reason).toBe('company_mismatch');
    expect(w.postBill).not.toHaveBeenCalled();
    expect(await countRows('exceptions', "reason_code='company_mismatch'")).toBe(1);
  });
});
