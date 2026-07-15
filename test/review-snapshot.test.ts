import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { query } from '../src/db/pool.js';
import { recordProofRef } from '../src/swarmsync/proof.js';
import { buildReviewSnapshot, deriveRisk } from '../src/services/review/snapshot.js';
import {
  resetTables, createTenant, insertMessage, insertAttachment, insertExtraction, closeAll,
} from './helpers.js';

/**
 * CHUNK_8_REVIEWDASH — snapshot.ts: tenant-scoped, secret-free, minor-unit amounts,
 * risk derivation per spec §14 Open Question 1's default mapping.
 */

async function insertProposal(
  t: number,
  opts: {
    attachmentId?: number | null;
    extractionId?: number | null;
    status?: string;
    flags?: string[];
    confidence?: number;
    vendorName?: string;
    totalAmt?: number;
    docNumber?: string;
  } = {},
): Promise<number> {
  const txn = {
    txnType: 'Bill',
    vendorRef: { value: 'V1', name: opts.vendorName ?? 'Acme Co' },
    DocNumber: opts.docNumber ?? 'INV-1',
    TxnDate: '2026-07-01',
    TotalAmt: opts.totalAmt ?? 100,
    lines: [{ Amount: opts.totalAmt ?? 100, description: 'work', accountRef: { value: '60' } }],
    tax: 0,
  };
  const { rows } = await query<{ id: number }>(
    `INSERT INTO proposals (tenant_id, attachment_id, extraction_id, proposed_txn, idempotency_key, confidence, status, flags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      t,
      opts.attachmentId ?? null,
      opts.extractionId ?? null,
      JSON.stringify(txn),
      `key-${Math.floor(performance.now() * 1000)}`,
      opts.confidence ?? 0.95,
      opts.status ?? 'review',
      opts.flags ?? [],
    ],
  );
  return rows[0]!.id;
}

const deps = { reviewThreshold: 0.6, company: 'Test Co', runId: 'run-fixed' };

describe('review snapshot — deriveRisk (Open Question 1 default)', () => {
  it('any critical/bank-change flag -> high, regardless of confidence', () => {
    expect(deriveRisk(['bank_change_warning'], 0.99, 0.6)).toBe('high');
    expect(deriveRisk(['duplicate'], 0.99, 0.6)).toBe('high');
    expect(deriveRisk(['fraud_flag'], 0.99, 0.6)).toBe('high');
  });
  it('confidence below REVIEW_THRESHOLD (and no critical flag) -> med', () => {
    expect(deriveRisk([], 0.5, 0.6)).toBe('med');
    expect(deriveRisk(['unknown_vendor'], 0.5, 0.6)).toBe('med');
  });
  it('confidence at/above REVIEW_THRESHOLD, no critical flag -> low', () => {
    expect(deriveRisk([], 0.95, 0.6)).toBe('low');
    expect(deriveRisk([], 0.6, 0.6)).toBe('low');
  });
});

describe('review snapshot — tenant scoping', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('never includes a foreign tenant\'s proposal', async () => {
    const t1 = await createTenant('Tenant One');
    const t2 = await createTenant('Tenant Two');
    const p1 = await insertProposal(t1, { vendorName: 'Only Tenant 1' });
    await insertProposal(t2, { vendorName: 'Only Tenant 2' });

    const snap = await buildReviewSnapshot(t1, deps);
    expect(snap.tenant).toBe(t1);
    expect(snap.proposals).toHaveLength(1);
    expect(snap.proposals[0]!.id).toBe(p1);
    expect(snap.proposals.some((p) => p.vendor === 'Only Tenant 2')).toBe(false);
  });

  it('only includes review/ready/exception proposals — not posted_sandbox or rejected', async () => {
    const t = await createTenant();
    await insertProposal(t, { status: 'review' });
    await insertProposal(t, { status: 'ready' });
    await insertProposal(t, { status: 'exception' });
    await insertProposal(t, { status: 'posted_sandbox' });
    await insertProposal(t, { status: 'rejected' });

    const snap = await buildReviewSnapshot(t, deps);
    expect(snap.proposals).toHaveLength(3);
    expect(snap.proposals.map((p) => p.status).sort()).toEqual(['exception', 'ready', 'review']);
  });
});

describe('review snapshot — amounts, risk, and secrets', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('amount_cents is an integer minor-unit value derived from proposed_txn.TotalAmt', async () => {
    const t = await createTenant();
    await insertProposal(t, { totalAmt: 123.45 });
    const snap = await buildReviewSnapshot(t, deps);
    expect(snap.proposals[0]!.amount_cents).toBe(12345);
    expect(Number.isInteger(snap.proposals[0]!.amount_cents)).toBe(true);
  });

  it('vendor totals and header summary are derived from the same proposals', async () => {
    const t = await createTenant();
    await insertProposal(t, { vendorName: 'Acme Co', totalAmt: 100, status: 'ready' });
    await insertProposal(t, { vendorName: 'Acme Co', totalAmt: 50, status: 'review' });
    await insertProposal(t, { vendorName: 'Other Co', totalAmt: 25, status: 'exception' });
    const snap = await buildReviewSnapshot(t, deps);
    expect(snap.summary).toEqual({ count: 3, ready: 1, review: 1, exception: 1, amount_cents: 17500 });
    const acme = snap.vendorTotals.find((v) => v.vendor === 'Acme Co');
    expect(acme).toEqual({ vendor: 'Acme Co', count: 2, amount_cents: 15000 });
  });

  it('risk flows from real flags/confidence on the row — high wins over low confidence', async () => {
    const t = await createTenant();
    const pHigh = await insertProposal(t, { flags: ['bank_change_warning'], confidence: 0.99 });
    const pMed = await insertProposal(t, { flags: [], confidence: 0.5 });
    const pLow = await insertProposal(t, { flags: [], confidence: 0.95 });
    const snap = await buildReviewSnapshot(t, deps);
    const byId = new Map(snap.proposals.map((p) => [p.id, p]));
    expect(byId.get(pHigh)!.risk).toBe('high');
    expect(byId.get(pMed)!.risk).toBe('med');
    expect(byId.get(pLow)!.risk).toBe('low');
  });

  it('no token/secret-shaped strings survive into the snapshot (excludes what src/logger.ts redacts)', async () => {
    const t = await createTenant();
    const m = await insertMessage(t, { subject: 'ssk_live_abcdEFGH12345678' });
    const a = await insertAttachment(t, m, { filename: 'ssk_live_abcdEFGH12345678.pdf' });
    const e = await insertExtraction(t, m, a, {}, 0.95);
    await insertProposal(t, { attachmentId: a, extractionId: e, vendorName: 'Bearer abcdefghijklmnopqrstuvwxyz012345' });
    const snap = await buildReviewSnapshot(t, deps);
    const dump = JSON.stringify(snap);
    expect(dump).not.toContain('ssk_live_abcdEFGH12345678');
    expect(dump).not.toMatch(/Bearer\s+[A-Za-z0-9._-]+/);
    expect(dump).toContain('[REDACTED]');
  });

  it('records the proof_refs verdict for a proposal that has one, and null when absent', async () => {
    const t = await createTenant();
    const m = await insertMessage(t);
    const a = await insertAttachment(t, m);
    const e = await insertExtraction(t, m, a, {}, 0.95);
    const withProof = await insertProposal(t, { attachmentId: a, extractionId: e });
    await recordProofRef({ tenantId: t, entityKind: 'proposal', entityId: String(withProof), product: 'invoiceproof', verdict: 'clean' });
    const withoutProof = await insertProposal(t, {});
    const snap = await buildReviewSnapshot(t, deps);
    const byId = new Map(snap.proposals.map((p) => [p.id, p]));
    expect(byId.get(withProof)!.proof).toEqual({ product: 'invoiceproof', verdict: 'clean' });
    expect(byId.get(withoutProof)!.proof).toBeNull();
  });
});
