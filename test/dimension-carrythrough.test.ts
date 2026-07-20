import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { postOnce } from '../src/pipeline/posting.js';
import { proposeOnce } from '../src/pipeline/mapping.js';
import { query } from '../src/db/pool.js';
import { recordProofRef } from '../src/swarmsync/proof.js';
import { resolveDimensions, hasUnhandledDimension, mappedSupportedDimensions } from '../src/mapping/dimensions.js';
import {
  resetTables, createTenant, createConnection, insertDimensionMapping,
  insertMessage, insertAttachment, insertExtraction, countRows, closeAll,
} from './helpers.js';
import type { QboWriteClient } from '../src/qbo/write.js';
import type { QboReadClient } from '../src/qbo/client.js';
import { createQboConnector } from '../src/connectors/qbo.js';

// F4: wrap the mock write client in the REAL adapter so payload/read-back assertions run
// at the adapter boundary where the QBO payload is actually built.
function mockRead(): QboReadClient {
  return { getCompanyInfo: vi.fn().mockResolvedValue({ CompanyName: 'Sandbox' }), queryEntity: vi.fn().mockResolvedValue([]) } as unknown as QboReadClient;
}

/**
 * F5 sub-item 1 — dimension carry-through. Supported dimensions are carried into the QBO
 * payload; unsupported / unmapped dimensions are surfaced and HELD (never dropped); a
 * post-write dimension mismatch raises a dedicated exception. NEW tests only.
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
const deps = (writer: QboWriteClient) => ({ connector: createQboConnector({ writeClient: writer, readClient: mockRead() }), anchor: okAnchor, loadPdf: async () => Buffer.from('%PDF'), amountCeiling: 10000, autoThreshold: 0.9 });

async function seedReadyProposal(t: number, txnOverride: Record<string, unknown> = {}, flags = '{}') {
  const m = await insertMessage(t);
  const a = await insertAttachment(t, m, { sha256: `sha-${t}-${Math.floor(performance.now() * 1000)}` });
  const sha = (await query<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id=$1', [a])).rows[0]!.sha256;
  const e = await insertExtraction(t, m, a, {}, 0.95);
  await recordProofRef({ tenantId: t, entityKind: 'extraction', entityId: String(e), product: 'verify_api', proofId: 'p', chainHash: 'h' });
  const txn = {
    txnType: 'Bill', vendorRef: { value: 'V1', name: 'Acme' }, DocNumber: 'INV-1', TxnDate: '2026-07-01',
    TotalAmt: 100, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }], tax: 0, ...txnOverride,
  };
  const pid = (
    await query<{ id: number }>(
      `INSERT INTO proposals (tenant_id, attachment_id, extraction_id, proposed_txn, idempotency_key, confidence, status, flags)
       VALUES ($1,$2,$3,$4,$5,0.95,'ready',$6) RETURNING id`,
      [t, a, e, JSON.stringify(txn), sha, flags],
    )
  ).rows[0]!.id;
  await recordProofRef({ tenantId: t, entityKind: 'proposal', entityId: String(pid), product: 'invoiceproof', verdict: 'clean' });
  return pid;
}

describe('F5 dimensions — resolver states', () => {
  it('distinguishes mapped / not_mapped / unsupported / not_provided / intentionally_blank', () => {
    const cands = [{ kind: 'class', key: 'west', targetId: 'CL1', targetName: 'West' }];
    const dims = resolveDimensions(
      [
        { kind: 'class', raw: 'West' }, // mapped
        { kind: 'location', raw: 'HQ' }, // supported but no candidate → not_mapped
        { kind: 'project', raw: 'P-9' }, // unsupported by provider
        { kind: 'class', raw: null }, // not provided → omitted
        { kind: 'location', raw: '' }, // intentionally blank
      ],
      cands,
    );
    expect(dims.find((d) => d.kind === 'class' && d.raw === 'West')).toMatchObject({ state: 'mapped', id: 'CL1' });
    expect(dims.find((d) => d.kind === 'location' && d.raw === 'HQ')).toMatchObject({ state: 'not_mapped' });
    expect(dims.find((d) => d.kind === 'project')).toMatchObject({ state: 'unsupported_by_provider' });
    expect(dims.find((d) => d.kind === 'location' && d.raw === '')).toMatchObject({ state: 'intentionally_blank' });
    expect(dims.filter((d) => d.kind === 'class' && d.raw == null)).toHaveLength(0); // not_provided → absent
    expect(hasUnhandledDimension(dims)).toBe(true);
    expect(mappedSupportedDimensions(dims)).toHaveLength(1);
  });
});

describe('F5 dimensions — posting', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('each supported dimension (class, location) is carried into the QBO payload', async () => {
    const t = await createTenant();
    const connId = await createConnection(t);
    const pid = await seedReadyProposal(t, {
      dimensions: [
        { kind: 'class', id: 'CL1', name: 'West', state: 'mapped' },
        { kind: 'location', id: 'LOC1', name: 'HQ', state: 'mapped' },
      ],
    });
    // FIX-pipeline-fail-closed: a 'mapped' dimension also needs a persisted, accepted
    // dimension_mappings row (migration 007) before it may post — see
    // src/mapping/dimensions.ts evaluateDimensionMappingRecord.
    await insertDimensionMapping(t, connId, pid, { dimensionType: 'class', rawValue: 'West', providerId: 'CL1', reviewStatus: 'accepted', resolutionState: 'mapped' });
    await insertDimensionMapping(t, connId, pid, { dimensionType: 'location', rawValue: 'HQ', providerId: 'LOC1', reviewStatus: 'accepted', resolutionState: 'mapped' });
    const w = mockWriter({
      readEntity: vi.fn().mockResolvedValue({
        TotalAmt: 100, DocNumber: 'INV-1', DepartmentRef: { value: 'LOC1' },
        Line: [{ AccountBasedExpenseLineDetail: { ClassRef: { value: 'CL1' } } }],
      }),
    });
    const out = await postOnce(t, pid, deps(w));
    expect(out.status).toBe('posted');
    const payload = (w.createEntity as any).mock.calls[0][1];
    expect(payload.DepartmentRef).toEqual({ value: 'LOC1' });
    expect(payload.Line[0].AccountBasedExpenseLineDetail.ClassRef).toEqual({ value: 'CL1' });
  });

  it('an unmapped/inactive dimension flag fails closed — never created', async () => {
    const t = await createTenant();
    const pid = await seedReadyProposal(t, {}, '{unmapped_dimension}');
    const w = mockWriter();
    const out = await postOnce(t, pid, deps(w));
    expect(out.status).toBe('held');
    expect((out as any).reason).toBe('blocking_flag');
    expect(w.createEntity).not.toHaveBeenCalled();
  });

  it('a post-write dimension mismatch marks the posting unverified and raises dimension_mismatch', async () => {
    const t = await createTenant();
    const connId = await createConnection(t);
    const pid = await seedReadyProposal(t, {
      dimensions: [{ kind: 'location', id: 'LOC1', name: 'HQ', state: 'mapped' }],
    });
    await insertDimensionMapping(t, connId, pid, { dimensionType: 'location', rawValue: 'HQ', providerId: 'LOC1', reviewStatus: 'accepted', resolutionState: 'mapped' });
    // Amount + DocNumber match; only the location the provider echoes back is wrong.
    const w = mockWriter({
      readEntity: vi.fn().mockResolvedValue({ TotalAmt: 100, DocNumber: 'INV-1', DepartmentRef: { value: 'WRONG' } }),
    });
    const out = await postOnce(t, pid, deps(w));
    expect(out.status).toBe('held');
    expect((out as any).reason).toBe('dimension_mismatch');
    expect(await countRows('exceptions', "reason_code='dimension_mismatch'")).toBe(1);
    // The generic verify_mismatch was NOT used for a dimension problem.
    expect(await countRows('exceptions', "reason_code='verify_mismatch'")).toBe(0);
  });
});

describe('F5 dimensions — mapping pipeline holds a present-but-unmapped dimension', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('a class hint with no configured mapping → exception (unmapped_dimension), not dropped', async () => {
    const t = await createTenant();
    await query(
      `INSERT INTO mappings (tenant_id, kind, source_key, target_qbo_id, target_name)
       VALUES ($1,'vendor','acme','V1','Acme'), ($1,'account','work','60','Subcontractors')`,
      [t],
    );
    const m = await insertMessage(t);
    const a = await insertAttachment(t, m);
    const e = await insertExtraction(t, m, a, { class_hint: 'West Division' }, 0.95);
    await recordProofRef({ tenantId: t, entityKind: 'extraction', entityId: String(e), product: 'verify_api', proofId: 'p', chainHash: 'h' });
    const out = await proposeOnce(t, { tenantId: t, extractionId: e, attachmentId: a, messageId: 0 },
      { scan: async () => ({ findings: [], raw: {} }), autoThreshold: 0.9, reviewThreshold: 0.6 });
    expect(out?.status).toBe('exception');
    expect(await countRows('exceptions', "reason_code='unmapped_dimension'")).toBe(1);
    // The dimension is preserved in the proposal, not silently dropped.
    const row = (await query<{ proposed_txn: any }>('SELECT proposed_txn FROM proposals WHERE id=$1', [out!.proposalId])).rows[0]!;
    expect(row.proposed_txn.dimensions.some((d: any) => d.kind === 'class' && d.state === 'not_mapped')).toBe(true);
  });
});
