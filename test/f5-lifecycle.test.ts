import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { postOnce } from '../src/pipeline/posting.js';
import { getPool, query } from '../src/db/pool.js';
import { recordProofRef } from '../src/swarmsync/proof.js';
import { createTaxMapping, editTaxMapping, replaceTaxMapping, revalidateTaxMapping, type ProviderCodeValidator } from '../src/services/taxMappings.js';
import { acceptDimensionMapping, rejectDimensionMapping } from '../src/services/dimensionMappings.js';
import {
  resetTables, createTenant, createUser, createConnection, insertProposal, insertDimensionMapping,
  insertMessage, insertAttachment, insertExtraction, countRows, closeAll,
} from './helpers.js';
import { mockConnector } from './connector-mock.js';
import type { ActorContext } from '../src/services/index.js';

/**
 * F5-lifecycle — replace/supersede immutability (#4), concurrent-edit determinism (#5),
 * and an audit-completeness spot-check on mutation types the smoke tests didn't touch (#6).
 */

async function actorFor(t: number, email = 'owner@example.com'): Promise<ActorContext> {
  const uid = await createUser(t, { role: 'owner_controller', email });
  return { userId: uid, tenantId: t, role: 'owner_controller', email };
}

const anchor = () => Promise.resolve({ proof_id: 'ap1', chain_hash: 'ch1', verification_status: 'passed' as const, confidence: 1, raw: {} });
const loadPdf = async () => Buffer.from('%PDF');
const postDeps = () => ({ connector: mockConnector(), anchor, loadPdf, amountCeiling: 10000, autoThreshold: 0.9 });

async function seedReadyProposal(t: number, txnOverride: Record<string, unknown> = {}) {
  const m = await insertMessage(t);
  const a = await insertAttachment(t, m, { sha256: `sha-${t}-${Math.floor(performance.now())}` });
  const sha = (await query<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id=$1', [a])).rows[0]!.sha256;
  const e = await insertExtraction(t, m, a, {}, 0.95);
  await recordProofRef({ tenantId: t, entityKind: 'extraction', entityId: String(e), product: 'verify_api', proofId: 'p', chainHash: 'h' });
  const txn = {
    txnType: 'Bill', vendorRef: { value: 'V1', name: 'Acme' }, DocNumber: 'INV-1', TxnDate: '2026-07-01',
    TotalAmt: 100, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }], tax: 0,
    ...txnOverride,
  };
  const pid = (
    await query<{ id: number }>(
      `INSERT INTO proposals (tenant_id, attachment_id, extraction_id, proposed_txn, idempotency_key, confidence, status, flags)
       VALUES ($1,$2,$3,$4,$5,0.95,'ready','{}') RETURNING id`,
      [t, a, e, JSON.stringify(txn), sha],
    )
  ).rows[0]!.id;
  await recordProofRef({ tenantId: t, entityKind: 'proposal', entityId: String(pid), product: 'invoiceproof', verdict: 'clean' });
  return pid;
}

describe('F5 lifecycle — supersede/replace immutability', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('a proposal already posted under the OLD mapping is untouched by a later replace; a NEW proposal uses the replacement', async () => {
    const t = await createTenant();
    const connId = await createConnection(t, { provider: 'qbo', externalCompany: 'sandbox-realm' });
    const ctx = await actorFor(t);
    const oldMapping = await createTaxMapping(ctx, {
      connectionId: connId, provider: 'qbo', providerTaxCode: 'TAX1',
      internalTaxTreatment: 'standard_sales_tax', taxMode: 'exclusive', reason: 'initial config',
    });

    // Post proposal 1 using the OLD (still-active) mapping.
    const pid1 = await seedReadyProposal(t, {
      TotalAmt: 108, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }],
      tax: { mode: 'exclusive', amount: 8, code: 'TAX1', subtotal: 100 },
    });
    const out1 = await postOnce(t, pid1, postDeps());
    expect(out1.status).toBe('posted');
    const posting1 = (await query<{ id: number; request: any }>('SELECT id, request FROM postings_ap WHERE tenant_id=$1 AND proposal_id=$2', [t, pid1])).rows[0]!;
    const requestBefore = JSON.stringify(posting1.request);

    // Now replace the mapping — old row inactive+superseded, new row active.
    const { old, replacement } = await replaceTaxMapping(ctx, oldMapping.id, {
      internalTaxTreatment: 'standard_sales_tax_v2', taxMode: 'exclusive', reason: 'rate correction',
    });
    expect(old.active).toBe(false);
    expect(old.supersededById).toBe(replacement.id);
    expect(replacement.active).toBe(true);

    // Proposal 1's posting record is byte-identical — history is immutable.
    const posting1After = (await query<{ request: any }>('SELECT request FROM postings_ap WHERE tenant_id=$1 AND proposal_id=$2', [t, pid1])).rows[0]!;
    expect(JSON.stringify(posting1After.request)).toBe(requestBefore);
    expect(await countRows('postings_ap', 'tenant_id=$1 AND proposal_id=$2', [t, pid1])).toBe(1); // never re-posted

    // Re-running postOnce against the already-posted proposal is a no-op hold (status gate),
    // NOT a re-evaluation against the new mapping — proves the past posting can never be
    // silently altered by a later config change.
    const replay = await postOnce(t, pid1, postDeps());
    expect(replay.status).toBe('held');
    expect((replay as any).reason).toContain('status=');
    expect(await countRows('postings_ap', 'tenant_id=$1 AND proposal_id=$2', [t, pid1])).toBe(1);

    // Proposal 2 (NEW) with the same provider tax code resolves against the REPLACEMENT
    // row (the old one is inactive and excluded from the gate's match) — but a freshly
    // replaced mapping is born needs_revalidation=true (fail-closed: a config change must
    // be confirmed before it can auto-post), so it holds until revalidated.
    const pid2 = await seedReadyProposal(t, {
      TotalAmt: 108, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }],
      tax: { mode: 'exclusive', amount: 8, code: 'TAX1', subtotal: 100 },
    });
    const out2Early = await postOnce(t, pid2, postDeps());
    expect(out2Early.status).toBe('held');
    expect((out2Early as any).reason).toBe('tax_mapping_needs_revalidation');

    const stillValid: ProviderCodeValidator = vi.fn().mockResolvedValue({ valid: true });
    await revalidateTaxMapping(ctx, replacement.id, { reason: 'confirm replacement code' }, stillValid);
    const out2 = await postOnce(t, pid2, postDeps());
    expect(out2.status).toBe('posted');
  });
});

describe('F5 lifecycle — concurrent edit safety', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('tax_mappings: two edits interleaved through the row-lock (FOR UPDATE) apply strictly sequentially — last commit wins, both recorded in the audit trail', async () => {
    const t = await createTenant();
    const connId = await createConnection(t, { provider: 'qbo', externalCompany: 'sandbox-realm' });
    const ctx = await actorFor(t);
    const created = await createTaxMapping(ctx, {
      connectionId: connId, provider: 'qbo', providerTaxCode: 'TAX1',
      internalTaxTreatment: 'v0', taxMode: 'exclusive', reason: 'init',
    });

    // Force the interleaving explicitly: hold the row lock on a raw client, start edit A
    // (blocks acquiring FOR UPDATE), release the lock, confirm A applied; THEN repeat with
    // edit B. This is what `getTaxMappingByIdTx`'s `SELECT ... FOR UPDATE` actually
    // guarantees under READ COMMITTED — strict serialization of the two writers, never a
    // lost update / corrupted mixed state.
    const holder1 = await getPool().connect();
    await holder1.query('BEGIN');
    await holder1.query('SELECT id FROM tax_mappings WHERE id=$1 FOR UPDATE', [created.id]);
    const editA = editTaxMapping(ctx, created.id, { internalTaxTreatment: 'v1-from-A', reason: 'editor A' });
    await new Promise((r) => setTimeout(r, 150)); // editA is now blocked waiting on the lock
    await holder1.query('COMMIT');
    holder1.release();
    const resultA = await editA;
    expect(resultA.internalTaxTreatment).toBe('v1-from-A');

    const holder2 = await getPool().connect();
    await holder2.query('BEGIN');
    await holder2.query('SELECT id FROM tax_mappings WHERE id=$1 FOR UPDATE', [created.id]);
    const editB = editTaxMapping(ctx, created.id, { internalTaxTreatment: 'v2-from-B', reason: 'editor B' });
    await new Promise((r) => setTimeout(r, 150));
    await holder2.query('COMMIT');
    holder2.release();
    const resultB = await editB;
    expect(resultB.internalTaxTreatment).toBe('v2-from-B');

    // Deterministic final state: the LAST committer wins, no corruption (exactly one row,
    // exactly the last writer's value), and BOTH edits are durably recorded in the audit
    // trail — neither was silently lost by the interleaving.
    const final = (await query<{ internal_tax_treatment: string }>('SELECT internal_tax_treatment FROM tax_mappings WHERE id=$1', [created.id])).rows[0]!;
    expect(final.internal_tax_treatment).toBe('v2-from-B');
    expect(await countRows('tax_mappings', 'id=$1', [created.id])).toBe(1);
    expect(await countRows('tax_mapping_audit', "tax_mapping_id=$1 AND action='edit'", [created.id])).toBe(2);
    expect(await countRows('tax_mapping_audit', "tax_mapping_id=$1 AND reason='editor A'", [created.id])).toBe(1);
    expect(await countRows('tax_mapping_audit', "tax_mapping_id=$1 AND reason='editor B'", [created.id])).toBe(1);
  });

  it('dimension_mappings: accept then reject on the same row (forced sequential via the row lock) is deterministic — reject wins reviewStatus, resolutionState from accept is NOT reverted', async () => {
    const t = await createTenant();
    const connId = await createConnection(t, { provider: 'qbo' });
    const proposalId = await insertProposal(t);
    const ctx = await actorFor(t);
    const rowId = await insertDimensionMapping(t, connId, proposalId, {
      dimensionType: 'class', rawValue: 'Marketing', proposedProviderId: '17', reviewStatus: 'pending', resolutionState: 'not_mapped',
    });

    const holder1 = await getPool().connect();
    await holder1.query('BEGIN');
    await holder1.query('SELECT id FROM dimension_mappings WHERE id=$1 FOR UPDATE', [rowId]);
    const acceptP = acceptDimensionMapping(ctx, rowId, {});
    await new Promise((r) => setTimeout(r, 150));
    await holder1.query('COMMIT');
    holder1.release();
    const acceptResult = await acceptP;
    expect(acceptResult.reviewStatus).toBe('accepted');
    expect(acceptResult.resolutionState).toBe('mapped');

    const holder2 = await getPool().connect();
    await holder2.query('BEGIN');
    await holder2.query('SELECT id FROM dimension_mappings WHERE id=$1 FOR UPDATE', [rowId]);
    const rejectP = rejectDimensionMapping(ctx, rowId, { status: 'rejected', reason: 'vendor cancelled after acceptance' });
    await new Promise((r) => setTimeout(r, 150));
    await holder2.query('COMMIT');
    holder2.release();
    const rejectResult = await rejectP;
    expect(rejectResult.reviewStatus).toBe('rejected');

    // Deterministic, explicit outcome under this codebase's actual write semantics:
    // `updateReviewStatusTx` (used by reject) touches ONLY review_status — resolution_state
    // and provider_id from the earlier accept are left exactly as accept wrote them. This
    // is a real, provable behavior (not an assumption): a rejected row can still carry a
    // 'mapped' resolution_state + a provider_id from a prior accept, which is why the
    // posting gate (`evaluateDimensionMappingRecord`) checks review_status separately from
    // resolution_state — reject alone is sufficient to hold, even on an otherwise-mapped row.
    const final = (await query<{ review_status: string; resolution_state: string; provider_id: string | null }>(
      'SELECT review_status, resolution_state, provider_id FROM dimension_mappings WHERE id=$1', [rowId],
    )).rows[0]!;
    expect(final.review_status).toBe('rejected');
    expect(final.resolution_state).toBe('mapped'); // NOT reverted by reject
    expect(final.provider_id).toBe('17'); // NOT cleared by reject
    expect(await countRows('dimension_mappings', 'id=$1', [rowId])).toBe(1); // exactly one row, no corruption

    // Both mutations are independently durable in the generic audit_log trail.
    expect(await countRows('audit_log', "entity=$1 AND action='dimension_mapping.accept'", [`dimension_mapping:${rowId}`])).toBe(1);
    expect(await countRows('audit_log', "entity=$1 AND action='dimension_mapping.rejected'", [`dimension_mapping:${rowId}`])).toBe(1);
  });
});

describe('F5 lifecycle — audit completeness spot-check (mutation types not covered by prior smoke tests)', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('tax_mappings.revalidate writes a tax_mapping_audit row with a real reason and the provider-check detail', async () => {
    const t = await createTenant();
    const connId = await createConnection(t, { provider: 'qbo' });
    const ctx = await actorFor(t);
    const created = await createTaxMapping(ctx, {
      connectionId: connId, provider: 'qbo', providerTaxCode: 'TAX1',
      internalTaxTreatment: 'v0', taxMode: 'exclusive', reason: 'init',
    });
    const stillValid: ProviderCodeValidator = vi.fn().mockResolvedValue({ valid: true, detail: 'confirmed active in QBO sandbox' });
    const revalidated = await revalidateTaxMapping(ctx, created.id, { reason: 'quarterly compliance sweep' }, stillValid);
    expect(revalidated.active).toBe(true);
    expect(revalidated.needsRevalidation).toBe(false);

    const auditRow = (await query<{ reason: string; changed_by: number }>(
      "SELECT reason, changed_by FROM tax_mapping_audit WHERE tax_mapping_id=$1 AND action='revalidate'", [created.id],
    )).rows[0]!;
    expect(auditRow.reason).toContain('quarterly compliance sweep');
    expect(auditRow.reason).toContain('confirmed active in QBO sandbox');
    expect(auditRow.changed_by).toBe(ctx.userId);
  });

  it('dimension_mappings.select-alternate, correct, and save-rule each leave a discoverable audit_log row with the real reason', async () => {
    const t = await createTenant();
    const connId = await createConnection(t, { provider: 'qbo' });
    const proposalId = await insertProposal(t);
    const ctx = await actorFor(t);

    const { selectAlternateDimensionMapping } = await import('../src/services/dimensionMappings.js');
    const { correctDimensionMapping, saveDimensionMappingRule } = await import('../src/services/dimensionMappings.js');

    const altRowId = await insertDimensionMapping(t, connId, proposalId, {
      dimensionType: 'class', rawValue: 'Mktg', reviewStatus: 'pending', resolutionState: 'not_mapped',
    });
    const validator = vi.fn().mockResolvedValue({ valid: true, providerId: '42' });
    await selectAlternateDimensionMapping(ctx, altRowId, { providerLabel: 'Marketing', reason: 'operator picked correct dept' }, validator);
    expect(
      await countRows('audit_log', "entity=$1 AND action='dimension_mapping.select_alternate' AND detail->>'reason'=$2", [
        `dimension_mapping:${altRowId}`, 'operator picked correct dept',
      ]),
    ).toBe(1);

    const correctRowId = await insertDimensionMapping(t, connId, proposalId, {
      dimensionType: 'class', rawValue: 'mktg dept', reviewStatus: 'pending', resolutionState: 'not_mapped',
    });
    await correctDimensionMapping(ctx, correctRowId, { normalizedValue: 'marketing department', reason: 'fixed OCR typo' });
    expect(
      await countRows('audit_log', "entity=$1 AND action='dimension_mapping.correct' AND detail->>'reason'=$2", [
        `dimension_mapping:${correctRowId}`, 'fixed OCR typo',
      ]),
    ).toBe(1);

    const ruleRowId = await insertDimensionMapping(t, connId, proposalId, {
      dimensionType: 'class', rawValue: 'Ops', normalizedValue: 'ops', proposedProviderId: '9', reviewStatus: 'pending', resolutionState: 'not_mapped',
    });
    await acceptDimensionMapping(ctx, ruleRowId, {});
    await saveDimensionMappingRule(ctx, ruleRowId, { reason: 'apply to all future Ops invoices' });
    expect(
      await countRows('audit_log', "entity=$1 AND action='dimension_mapping.save_rule' AND detail->>'reason'=$2", [
        `dimension_mapping:${ruleRowId}`, 'apply to all future Ops invoices',
      ]),
    ).toBe(1);
  });
});
