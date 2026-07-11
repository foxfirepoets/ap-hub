import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { proposeOnce } from '../src/pipeline/mapping.js';
import { query } from '../src/db/pool.js';
import { recordProofRef, hasProofRef } from '../src/swarmsync/proof.js';
import {
  resetTables, createTenant, insertMessage, insertAttachment, insertExtraction, countRows, closeAll,
} from './helpers.js';

const deps = (scan: any) => ({ scan, autoThreshold: 0.9, reviewThreshold: 0.6 });
const cleanScan = async () => ({ findings: [], raw: {} });

async function seedVendorAndAccount(t: number) {
  await query(
    `INSERT INTO mappings (tenant_id, kind, source_key, target_qbo_id, target_name)
     VALUES ($1,'vendor','acme','V1','Acme'), ($1,'account','work','60','Subcontractors')`,
    [t],
  );
}
async function seedReadyExtraction(t: number) {
  const m = await insertMessage(t);
  const a = await insertAttachment(t, m);
  const e = await insertExtraction(t, m, a, {}, 0.95);
  // Verify proof from CHUNK_5 must exist for a ready proposal.
  await recordProofRef({ tenantId: t, entityKind: 'extraction', entityId: String(e), product: 'verify_api', proofId: 'p', chainHash: 'h' });
  return { m, a, e };
}

describe('CHUNK_6 mapping pipeline', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('ready path: known vendor + account + both proofs + clean scan → status ready', async () => {
    const t = await createTenant();
    await seedVendorAndAccount(t);
    const { a, e } = await seedReadyExtraction(t);
    const out = await proposeOnce(t, { tenantId: t, extractionId: e, attachmentId: a, messageId: 0 }, deps(cleanScan));
    expect(out?.status).toBe('ready');
    // proof_refs_recorded: both proofs present.
    expect(await hasProofRef(t, 'proposal', String(out!.proposalId), 'invoiceproof')).toBe(true);
    expect(await hasProofRef(t, 'extraction', String(e), 'verify_api')).toBe(true);
  });

  it('never-ready-without-both-proofs: missing verify proof → review, not ready', async () => {
    const t = await createTenant();
    await seedVendorAndAccount(t);
    const m = await insertMessage(t);
    const a = await insertAttachment(t, m);
    const e = await insertExtraction(t, m, a, {}, 0.95); // NO verify proof recorded
    const out = await proposeOnce(t, { tenantId: t, extractionId: e, attachmentId: a, messageId: 0 }, deps(cleanScan));
    expect(out?.status).toBe('review');
  });

  it('invoiceproof_gate: bank-change critical → exception, never ready', async () => {
    const t = await createTenant();
    await seedVendorAndAccount(t);
    const { a, e } = await seedReadyExtraction(t);
    const out = await proposeOnce(t, { tenantId: t, extractionId: e, attachmentId: a, messageId: 0 },
      deps(async () => ({ findings: [{ severity: 'critical', pattern: 'BANK_ACCOUNT_CHANGE_DETECTED' }], raw: {} })));
    expect(out?.status).toBe('exception');
    expect(await countRows('exceptions', "reason_code='bank_change_warning'")).toBe(1);
  });

  it('unknown_vendor: no mapping → unknown_vendor exception, not a wrong guess', async () => {
    const t = await createTenant();
    const { a, e } = await seedReadyExtraction(t); // no vendor mapping seeded
    const out = await proposeOnce(t, { tenantId: t, extractionId: e, attachmentId: a, messageId: 0 }, deps(cleanScan));
    expect(out?.status).toBe('exception');
    expect(await countRows('exceptions', "reason_code='unknown_vendor'")).toBe(1);
  });

  it('proof_fail_safe: scan outage caps at review with proof_scan_unavailable', async () => {
    const t = await createTenant();
    await seedVendorAndAccount(t);
    const { a, e } = await seedReadyExtraction(t);
    const out = await proposeOnce(t, { tenantId: t, extractionId: e, attachmentId: a, messageId: 0 },
      deps(async () => { throw new Error('down'); }));
    expect(out?.status).toBe('review');
    expect(await countRows('exceptions', "reason_code='proof_scan_unavailable'")).toBe(1);
  });
});
