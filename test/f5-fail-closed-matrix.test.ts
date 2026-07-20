import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { postOnce } from '../src/pipeline/posting.js';
import { query } from '../src/db/pool.js';
import { recordProofRef } from '../src/swarmsync/proof.js';
import {
  resetTables, createTenant, createConnection, insertDimensionMapping,
  insertMessage, insertAttachment, insertExtraction, closeAll,
} from './helpers.js';
import { mockConnector } from './connector-mock.js';
import type { AccountingConnector } from '../src/connectors/types.js';

/**
 * F5-fail-closed-matrix — fills the gaps `posting.test.ts` / `tax-handling.test.ts` /
 * `dimension-mapping-persist.test.ts` leave in the required truth tables:
 *   tax:       missing row / inactive / needs_revalidation / active-valid  (already fully
 *              covered in posting.test.ts — not repeated here)
 *   dimension: all 5 resolution_states x posting outcome, PLUS the "genuinely absent"
 *              case (no entry at all in proposed_txn.dimensions) contrasted against
 *              'not_mapped' (present but unresolved) — the two are easy to conflate but
 *              behave completely differently at the gate.
 */

const okAnchor = vi.fn().mockResolvedValue({ proof_id: 'ap1', chain_hash: 'ch1', verification_status: 'passed', confidence: 1, raw: {} });
const loadPdf = async () => Buffer.from('%PDF');
const deps = (connector: AccountingConnector) => ({ connector, anchor: okAnchor, loadPdf, amountCeiling: 10000, autoThreshold: 0.9 });

async function seedReadyProposal(t: number, dimensions?: unknown[]) {
  const m = await insertMessage(t);
  const a = await insertAttachment(t, m, { sha256: `sha-${t}-${Math.floor(performance.now())}` });
  const sha = (await query<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id=$1', [a])).rows[0]!.sha256;
  const e = await insertExtraction(t, m, a, {}, 0.95);
  await recordProofRef({ tenantId: t, entityKind: 'extraction', entityId: String(e), product: 'verify_api', proofId: 'p', chainHash: 'h' });
  const txn: Record<string, unknown> = {
    txnType: 'Bill', vendorRef: { value: 'V1', name: 'Acme' }, DocNumber: 'INV-1', TxnDate: '2026-07-01',
    TotalAmt: 100, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }], tax: 0,
  };
  if (dimensions !== undefined) txn.dimensions = dimensions;
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

describe('F5 fail-closed matrix — dimension resolution_state x posting outcome', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('unsupported_by_provider: a persisted row with that resolution_state holds, never posts', async () => {
    const t = await createTenant();
    const connId = await createConnection(t, { provider: 'qbo', externalCompany: 'sandbox-realm' });
    const pid = await seedReadyProposal(t, [{ kind: 'project', raw: 'P-9', state: 'unsupported_by_provider' }]);
    await insertDimensionMapping(t, connId, pid, {
      dimensionType: 'project', rawValue: 'P-9', reviewStatus: 'held', resolutionState: 'unsupported_by_provider',
    });
    const w = mockConnector();
    const out = await postOnce(t, pid, deps(w));
    expect(out.status).toBe('held');
    expect((out as any).reason).toBe('dimension_mapping_not_mapped');
    expect(w.postBill).not.toHaveBeenCalled();
  });

  it('not_provided: a persisted row with that resolution_state holds, never posts (distinct from a missing row)', async () => {
    const t = await createTenant();
    const connId = await createConnection(t, { provider: 'qbo', externalCompany: 'sandbox-realm' });
    // Contrived (resolveDimensions never emits 'not_provided' into the array — a genuinely
    // absent value is simply omitted) but the persisted-row CHECK constraint and the gate
    // both explicitly handle it, so it must fail closed like any other non-'mapped' state.
    const pid = await seedReadyProposal(t, [{ kind: 'department', raw: 'HQ', state: 'not_provided' }]);
    await insertDimensionMapping(t, connId, pid, {
      dimensionType: 'department', rawValue: 'HQ', reviewStatus: 'pending', resolutionState: 'not_provided',
    });
    const w = mockConnector();
    const out = await postOnce(t, pid, deps(w));
    expect(out.status).toBe('held');
    expect((out as any).reason).toBe('dimension_mapping_not_mapped');
    expect(w.postBill).not.toHaveBeenCalled();
  });

  it('mapped + accepted posts; mapped + still pending (row exists but not human-reviewed) holds', async () => {
    const t = await createTenant();
    const connId = await createConnection(t, { provider: 'qbo', externalCompany: 'sandbox-realm' });

    const pidOk = await seedReadyProposal(t, [{ kind: 'class', raw: 'West', id: 'CL1', name: 'West', state: 'mapped' }]);
    await insertDimensionMapping(t, connId, pidOk, {
      dimensionType: 'class', rawValue: 'West', providerId: 'CL1', reviewStatus: 'accepted', resolutionState: 'mapped',
    });
    const outOk = await postOnce(t, pidOk, deps(mockConnector()));
    expect(outOk.status).toBe('posted');

    const pidPending = await seedReadyProposal(t, [{ kind: 'class', raw: 'West', id: 'CL1', name: 'West', state: 'mapped' }]);
    await insertDimensionMapping(t, connId, pidPending, {
      dimensionType: 'class', rawValue: 'West', providerId: 'CL1', reviewStatus: 'pending', resolutionState: 'mapped',
    });
    const outPending = await postOnce(t, pidPending, deps(mockConnector()));
    expect(outPending.status).toBe('held');
    expect((outPending as any).reason).toBe('dimension_mapping_not_reviewed');
  });

  it('genuinely absent (no entry in proposed_txn.dimensions at all) posts with NO row required — distinct from not_mapped', async () => {
    const t = await createTenant();
    await createConnection(t, { provider: 'qbo', externalCompany: 'sandbox-realm' });

    // Case 1: the dimension key is entirely absent from the array — never even attempted
    // extraction of a class/location for this invoice. No dimension_mappings row exists at
    // all, and none is required: the gate loop iterates txn.dimensions, which is empty.
    const pidAbsent = await seedReadyProposal(t, []);
    const outAbsent = await postOnce(t, pidAbsent, deps(mockConnector()));
    expect(outAbsent.status).toBe('posted');

    // Case 2 (contrast): the SAME kind IS present but unresolved ('not_mapped') — this one
    // is a value the source actually carried that couldn't be matched, and MUST hold even
    // with zero dimension_mappings row (never guessed).
    const pidNotMapped = await seedReadyProposal(t, [{ kind: 'class', raw: 'Nonexistent Division', state: 'not_mapped' }]);
    const outNotMapped = await postOnce(t, pidNotMapped, deps(mockConnector()));
    expect(outNotMapped.status).toBe('held');
    expect((outNotMapped as any).reason).toBe('dimension_mapping_not_found');
  });

  it('no `dimensions` key at all on proposed_txn behaves identically to an empty array — posts', async () => {
    const t = await createTenant();
    await createConnection(t, { provider: 'qbo', externalCompany: 'sandbox-realm' });
    const pid = await seedReadyProposal(t, undefined); // omit the key entirely
    const out = await postOnce(t, pid, deps(mockConnector()));
    expect(out.status).toBe('posted');
  });
});
