import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { postOnce } from '../src/pipeline/posting.js';
import { query } from '../src/db/pool.js';
import { recordProofRef, hasProofRef } from '../src/swarmsync/proof.js';
import {
  resetTables, createTenant, insertMessage, insertAttachment, insertExtraction, countRows, closeAll,
} from './helpers.js';
import type { QboWriteClient } from '../src/qbo/write.js';

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

const deps = (writer: QboWriteClient, anchor = okAnchor) => ({ writer, anchor, loadPdf, amountCeiling: 10000, autoThreshold: 0.9 });

describe('CHUNK_7 posting', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('create_and_verify: creates one sandbox txn, verifies, records posting + reconciliation', async () => {
    const t = await createTenant();
    const { proposalId } = await seedReadyProposal(t);
    const w = mockWriter();
    const out = await postOnce(t, proposalId, deps(w));
    expect(out.status).toBe('posted');
    expect(w.createEntity).toHaveBeenCalledTimes(1);
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
    expect(w.createEntity).toHaveBeenCalledTimes(1); // NOT re-created
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
    expect(w.createEntity).toHaveBeenCalledTimes(1);
    expect(await countRows('postings')).toBe(1);
  });

  it('replay_after_timeout: create times out but the txn exists → adopt, no duplicate', async () => {
    const t = await createTenant();
    const { proposalId } = await seedReadyProposal(t);
    const w = mockWriter({
      createEntity: vi.fn().mockRejectedValue(new Error('network timeout')),
      // Pre-create dedup sees nothing; after the timed-out create, the txn exists → adopt.
      queryExisting: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ Id: 'q-existing' }]),
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
    expect(w1.createEntity).not.toHaveBeenCalled();

    const big = await seedReadyProposal(t, { total: 999999 });
    const w2 = mockWriter();
    expect((await postOnce(t, big.proposalId, deps(w2))).status).toBe('held');
    expect(w2.createEntity).not.toHaveBeenCalled();
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
    expect(w.createEntity).not.toHaveBeenCalled();
  });
});
