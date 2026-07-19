import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { proposeOnce } from '../src/pipeline/mapping.js';
import { resolveVendor } from '../src/mapping/resolve.js';
import { query } from '../src/db/pool.js';
import { recordProofRef } from '../src/swarmsync/proof.js';
import {
  resetTables, createTenant, insertMessage, insertAttachment, insertExtraction, countRows, closeAll,
} from './helpers.js';

/**
 * F5 sub-item 3 — vendor review policy. Deterministic gates, not score alone: only an
 * unambiguous exact/normalized-exact match auto-posts; fuzzy / multiple / ambiguous are
 * forced to review; no-match stays a hold (unknown_vendor exception — unchanged, since an
 * existing test asserts that). NEW tests only.
 */

const deps = { scan: async () => ({ findings: [] as any[], raw: {} }), autoThreshold: 0.9, reviewThreshold: 0.6 };

async function seedExtraction(t: number, fields: Record<string, unknown>) {
  const m = await insertMessage(t);
  const a = await insertAttachment(t, m);
  const e = await insertExtraction(t, m, a, fields, 0.95);
  await recordProofRef({ tenantId: t, entityKind: 'extraction', entityId: String(e), product: 'verify_api', proofId: 'p', chainHash: 'h' });
  return { a, e };
}
async function seedAccount(t: number) {
  await query(`INSERT INTO mappings (tenant_id, kind, source_key, target_qbo_id, target_name) VALUES ($1,'account','work','60','Subs')`, [t]);
}

describe('F5 vendor — resolver gates', () => {
  it('exact provider-id / normalized-exact name → exact (auto-eligible)', () => {
    expect(resolveVendor('ACME LLC', null, [{ sourceKey: 'acme', targetId: 'V1', targetName: 'Acme' }])).toMatchObject({ status: 'exact', matchType: 'normalized_name' });
  });
  it('fuzzy single candidate → fuzzy with reasons', () => {
    const r = resolveVendor('Acme Building Supplies', null, [{ sourceKey: 'acme building supply inc', targetId: 'V1', targetName: 'Acme Building Supply' }]);
    expect(r.status).toBe('fuzzy');
    expect((r as any).reasons).toContain('fuzzy_name_match');
  });
  it('multiple fuzzy candidates → conflicts retained', () => {
    const r = resolveVendor('Acme Building Supply Co', null, [
      { sourceKey: 'a', targetId: 'V1', targetName: 'Acme Building Supply' },
      { sourceKey: 'b', targetId: 'V2', targetName: 'Acme Building Supplies' },
    ]);
    expect(r.status).toBe('fuzzy');
    expect((r as any).conflicts.length).toBeGreaterThanOrEqual(1);
    expect((r as any).reasons).toContain('multiple_candidates');
  });
  it('ambiguous exact (same name → two different targets) is flagged ambiguous', () => {
    const r = resolveVendor('Acme', null, [
      { sourceKey: 'acme', targetId: 'V1', targetName: 'Acme' },
      { sourceKey: 'acme', targetId: 'V2', targetName: 'Acme Inc' },
    ]);
    expect(r).toMatchObject({ status: 'exact', ambiguous: true });
  });
  it('no candidate → unknown', () => {
    expect(resolveVendor('Nobody', null, []).status).toBe('unknown');
  });
  it('reviewer override: adding an exact mapping makes the next resolve auto-eligible', () => {
    // Before: fuzzy → review. After a reviewer records the exact source key, it is exact.
    const after = resolveVendor('Acme Building Supplies', null, [{ sourceKey: 'acme building supplies', targetId: 'V9', targetName: 'Acme Building Supply' }]);
    expect(after).toMatchObject({ status: 'exact', targetId: 'V9' });
  });
});

describe('F5 vendor — pipeline routing', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('normalized-exact vendor → ready (auto)', async () => {
    const t = await createTenant();
    await seedAccount(t);
    await query(`INSERT INTO mappings (tenant_id, kind, source_key, target_qbo_id, target_name) VALUES ($1,'vendor','acme','V1','Acme')`, [t]);
    const { a, e } = await seedExtraction(t, { vendor_name: 'ACME LLC' });
    const out = await proposeOnce(t, { tenantId: t, extractionId: e, attachmentId: a, messageId: 0 }, deps);
    expect(out?.status).toBe('ready');
  });

  it('fuzzy vendor → review (never auto), with retained review evidence', async () => {
    const t = await createTenant();
    await seedAccount(t);
    await query(`INSERT INTO mappings (tenant_id, kind, source_key, target_qbo_id, target_name) VALUES ($1,'vendor','acme building supply inc','V1','Acme Building Supply')`, [t]);
    const { a, e } = await seedExtraction(t, { vendor_name: 'Acme Building Supplies', bank_info: 'IBAN123' });
    const out = await proposeOnce(t, { tenantId: t, extractionId: e, attachmentId: a, messageId: 0 }, deps);
    expect(out?.status).toBe('review');
    const row = (await query<{ proposed_txn: any; flags: string[] }>('SELECT proposed_txn, flags FROM proposals WHERE id=$1', [out!.proposalId])).rows[0]!;
    expect(row.flags).toContain('vendor_review');
    expect(row.proposed_txn.vendorReview).toMatchObject({ extractedName: 'Acme Building Supplies', status: 'fuzzy', bankInfoPresent: true });
    expect(row.proposed_txn.vendorReview.reasons).toContain('fuzzy_name_match');
  });

  it('multiple candidates → review, conflicts retained', async () => {
    const t = await createTenant();
    await seedAccount(t);
    await query(
      `INSERT INTO mappings (tenant_id, kind, source_key, target_qbo_id, target_name)
       VALUES ($1,'vendor','a','V1','Acme Building Supply'), ($1,'vendor','b','V2','Acme Building Supplies')`,
      [t],
    );
    const { a, e } = await seedExtraction(t, { vendor_name: 'Acme Building Supply Co' });
    const out = await proposeOnce(t, { tenantId: t, extractionId: e, attachmentId: a, messageId: 0 }, deps);
    expect(out?.status).toBe('review');
    const row = (await query<{ proposed_txn: any }>('SELECT proposed_txn FROM proposals WHERE id=$1', [out!.proposalId])).rows[0]!;
    expect(row.proposed_txn.vendorReview.conflicts.length).toBeGreaterThanOrEqual(1);
  });

  it('no candidate → held (unknown_vendor exception, never a guessed auto-post)', async () => {
    const t = await createTenant();
    await seedAccount(t);
    const { a, e } = await seedExtraction(t, { vendor_name: 'Totally Unknown Co' });
    const out = await proposeOnce(t, { tenantId: t, extractionId: e, attachmentId: a, messageId: 0 }, deps);
    expect(out?.status).toBe('exception');
    expect(await countRows('exceptions', "reason_code='unknown_vendor'")).toBe(1);
  });

  it('bank-change high-risk finding → exception (never auto), review evidence records bank presence', async () => {
    const t = await createTenant();
    await seedAccount(t);
    await query(`INSERT INTO mappings (tenant_id, kind, source_key, target_qbo_id, target_name) VALUES ($1,'vendor','acme','V1','Acme')`, [t]);
    const { a, e } = await seedExtraction(t, { vendor_name: 'Acme', bank_info: 'NEW-IBAN' });
    const out = await proposeOnce(t, { tenantId: t, extractionId: e, attachmentId: a, messageId: 0 },
      { ...deps, scan: async () => ({ findings: [{ severity: 'critical', pattern: 'BANK_ACCOUNT_CHANGE_DETECTED' }], raw: {} }) });
    expect(out?.status).toBe('exception');
    expect(await countRows('exceptions', "reason_code='bank_change_warning'")).toBe(1);
    const row = (await query<{ proposed_txn: any }>('SELECT proposed_txn FROM proposals WHERE id=$1', [out!.proposalId])).rows[0]!;
    expect(row.proposed_txn.vendorReview.bankInfoPresent).toBe(true);
  });
});
