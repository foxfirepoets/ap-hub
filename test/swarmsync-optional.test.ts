import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { proposeOnce } from '../src/pipeline/mapping.js';
import { postOnce } from '../src/pipeline/posting.js';
import { query } from '../src/db/pool.js';
import { hasProofRef } from '../src/swarmsync/proof.js';
import {
  resetTables, createTenant, insertMessage, insertAttachment, insertExtraction, countRows, closeAll,
} from './helpers.js';
import type { QboWriteClient } from '../src/qbo/write.js';

async function seedVendorAndAccount(t: number): Promise<void> {
  await query(
    `INSERT INTO mappings (tenant_id, kind, source_key, target_qbo_id, target_name)
     VALUES ($1,'vendor','acme','V1','Acme'), ($1,'account','work','60','Subcontractors')`,
    [t],
  );
}
// An extraction with NO Verify-API proof recorded (the OFF case never creates one).
async function seedExtractionNoProof(t: number): Promise<{ a: number; e: number }> {
  const m = await insertMessage(t);
  const a = await insertAttachment(t, m);
  const e = await insertExtraction(t, m, a, {}, 0.95);
  return { a, e };
}

function mockWriter(): QboWriteClient {
  return {
    realm: 'sandbox-realm',
    createEntity: vi.fn().mockResolvedValue({ id: 'q1', syncToken: '0', entity: { Id: 'q1' } }),
    readEntity: vi.fn().mockResolvedValue({ TotalAmt: 100, DocNumber: 'INV-1' }),
    queryExisting: vi.fn().mockResolvedValue([]),
    attach: vi.fn().mockResolvedValue(undefined),
  } as unknown as QboWriteClient;
}

describe('SwarmSync optional (ap-hub)', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('off_autopost: no proofs and the InvoiceProof scan is skipped -> status ready', async () => {
    const t = await createTenant();
    await seedVendorAndAccount(t);
    const { a, e } = await seedExtractionNoProof(t);
    const scan = vi.fn(async () => { throw new Error('scan must not be called when SwarmSync is off'); });
    const out = await proposeOnce(
      t, { tenantId: t, extractionId: e, attachmentId: a, messageId: 0 },
      { scan, autoThreshold: 0.9, reviewThreshold: 0.6, swarmSync: 'off_autopost' },
    );
    expect(out?.status).toBe('ready');
    expect(scan).not.toHaveBeenCalled();
    // No proof refs were created (SwarmSync made no outbound calls).
    expect(await hasProofRef(t, 'proposal', String(out!.proposalId), 'invoiceproof')).toBe(false);
    expect(await countRows('exceptions', "reason_code='proof_scan_unavailable'")).toBe(0);
  });

  it('off_review: no proofs, scan skipped -> caps at review (human approves)', async () => {
    const t = await createTenant();
    await seedVendorAndAccount(t);
    const { a, e } = await seedExtractionNoProof(t);
    const scan = vi.fn(async () => ({ findings: [], raw: {} }));
    const out = await proposeOnce(
      t, { tenantId: t, extractionId: e, attachmentId: a, messageId: 0 },
      { scan, autoThreshold: 0.9, reviewThreshold: 0.6, swarmSync: 'off_review' },
    );
    expect(out?.status).toBe('review');
    expect(scan).not.toHaveBeenCalled();
  });

  it('off modes still exception on a blocking extraction condition (unknown vendor)', async () => {
    const t = await createTenant(); // no vendor mapping seeded
    const { a, e } = await seedExtractionNoProof(t);
    const out = await proposeOnce(
      t, { tenantId: t, extractionId: e, attachmentId: a, messageId: 0 },
      { scan: vi.fn(), autoThreshold: 0.9, reviewThreshold: 0.6, swarmSync: 'off_autopost' },
    );
    expect(out?.status).toBe('exception');
    expect(await countRows('exceptions', "reason_code='unknown_vendor'")).toBe(1);
  });

  it('posting: with SwarmSync disabled, a ready proposal posts WITHOUT proof coverage (gate skipped, no anchor)', async () => {
    const t = await createTenant();
    const m = await insertMessage(t);
    const a = await insertAttachment(t, m, { sha256: `sha-${t}-noproof` });
    const e = await insertExtraction(t, m, a, {}, 0.95);
    const txn = { txnType: 'Bill', vendorRef: { value: 'V1', name: 'Acme' }, DocNumber: 'INV-1', TxnDate: '2026-07-01', TotalAmt: 100, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }], tax: 0 };
    const pid = (
      await query<{ id: number }>(
        `INSERT INTO proposals (tenant_id, attachment_id, extraction_id, proposed_txn, idempotency_key, confidence, status, flags)
         VALUES ($1,$2,$3,$4,$5,0.95,'ready','{}') RETURNING id`,
        [t, a, e, JSON.stringify(txn), `sha-${t}-noproof`],
      )
    ).rows[0]!.id;
    // No invoiceproof / verify_api proof refs recorded at all.
    const anchor = vi.fn();
    const out = await postOnce(t, pid, {
      writer: mockWriter(), anchor, loadPdf: async () => Buffer.from('%PDF'),
      amountCeiling: 10000, autoThreshold: 0.9, swarmSyncEnabled: false,
    });
    expect(out.status).toBe('posted');
    expect(anchor).not.toHaveBeenCalled(); // AuditProof anchoring skipped when off
    const posting = (await query<{ id: number }>('SELECT id FROM postings LIMIT 1')).rows[0]!.id;
    expect(await hasProofRef(t, 'posting', String(posting), 'auditproof')).toBe(false);
  });
});
