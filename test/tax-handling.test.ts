import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { postOnce } from '../src/pipeline/posting.js';
import { evaluateTax } from '../src/mapping/tax.js';
import { query } from '../src/db/pool.js';
import { recordProofRef } from '../src/swarmsync/proof.js';
import {
  resetTables, createTenant, createConnection, insertMessage, insertAttachment, insertExtraction, countRows, closeAll,
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
 * F5 sub-item 2 — tax handling. Tax is only written when a configured code exists AND it
 * reconciles; otherwise the invoice is HELD with a NAMED reason BEFORE create. NEW tests.
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

async function seedProposal(t: number, txnOverride: Record<string, unknown>, readBackTotal = 100) {
  const m = await insertMessage(t);
  const a = await insertAttachment(t, m, { sha256: `sha-${t}-${Math.floor(performance.now() * 1000)}` });
  const sha = (await query<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id=$1', [a])).rows[0]!.sha256;
  const e = await insertExtraction(t, m, a, {}, 0.95);
  await recordProofRef({ tenantId: t, entityKind: 'extraction', entityId: String(e), product: 'verify_api', proofId: 'p', chainHash: 'h' });
  const txn = {
    txnType: 'Bill', vendorRef: { value: 'V1', name: 'Acme' }, DocNumber: 'INV-1', TxnDate: '2026-07-01',
    TotalAmt: 100, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }], ...txnOverride,
  };
  const pid = (
    await query<{ id: number }>(
      `INSERT INTO proposals (tenant_id, attachment_id, extraction_id, proposed_txn, idempotency_key, confidence, status, flags)
       VALUES ($1,$2,$3,$4,$5,0.95,'ready','{}') RETURNING id`,
      [t, a, e, JSON.stringify(txn), sha],
    )
  ).rows[0]!.id;
  await recordProofRef({ tenantId: t, entityKind: 'proposal', entityId: String(pid), product: 'invoiceproof', verdict: 'clean' });
  return { pid, readBackTotal };
}

describe('F5 tax — evaluateTax (pure)', () => {
  const base = { TotalAmt: 110, lines: [{ Amount: 100 }] };
  it('no tax (0) → none', () => {
    expect(evaluateTax({ ...base, TotalAmt: 100, tax: 0 }).kind).toBe('none');
  });
  it('exclusive tax with code that reconciles → ok', () => {
    const d = evaluateTax({ ...base, tax: { mode: 'exclusive', amount: 10, code: 'TAX1', subtotal: 100 } });
    expect(d.kind).toBe('ok');
  });
  it('inclusive tax with code that reconciles → ok (not converted)', () => {
    const d = evaluateTax({ TotalAmt: 110, lines: [{ Amount: 110 }], tax: { mode: 'inclusive', amount: 10, code: 'TAX1', subtotal: 110 } });
    expect(d.kind).toBe('ok');
  });
  it('tax amount without a code → hold tax_unmapped', () => {
    const d = evaluateTax({ ...base, tax: { mode: 'exclusive', amount: 10, subtotal: 100 } });
    expect(d).toMatchObject({ kind: 'hold', reason: 'tax_unmapped' });
  });
  it('a bare number tax (no structure) → hold tax_unmapped', () => {
    const d = evaluateTax({ ...base, tax: 10 });
    expect(d).toMatchObject({ kind: 'hold', reason: 'tax_unmapped' });
  });
  it('non-reconciling tax → hold tax_unreconciled', () => {
    const d = evaluateTax({ TotalAmt: 200, lines: [{ Amount: 100 }], tax: { mode: 'exclusive', amount: 10, code: 'TAX1', subtotal: 100 } });
    expect(d).toMatchObject({ kind: 'hold', reason: 'tax_unreconciled' });
  });
});

// FIX-pipeline-fail-closed: a reconciling code must also have an active, non-stale
// tax_mappings row (migration 007) before it may post — see src/mapping/tax.ts
// evaluateTaxMappingRecord. Tests that expect a code to post configure one here.
async function activeTaxMapping(t: number, code = 'TAX1') {
  const connId = await createConnection(t, { provider: 'qbo', externalCompany: 'sandbox-realm' });
  await query(
    `INSERT INTO tax_mappings (tenant_id, connection_id, provider, provider_tax_code, internal_tax_treatment, tax_mode, active, needs_revalidation)
     VALUES ($1,$2,'qbo',$3,'Standard Sales Tax','exclusive',true,false)`,
    [t, connId, code],
  );
}

describe('F5 tax — posting', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('no-tax invoice posts with no tax line in the payload', async () => {
    const t = await createTenant();
    const { pid } = await seedProposal(t, { tax: 0 });
    const w = mockWriter();
    const out = await postOnce(t, pid, deps(w));
    expect(out.status).toBe('posted');
    expect((w.createEntity as any).mock.calls[0][1].TxnTaxDetail).toBeUndefined();
  });

  it('invoice-level tax that reconciles posts with a tax line carrying the configured code', async () => {
    const t = await createTenant();
    await activeTaxMapping(t);
    const { pid } = await seedProposal(t, {
      TotalAmt: 110, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }],
      tax: { mode: 'exclusive', amount: 10, code: 'TAX1', subtotal: 100 },
    });
    const w = mockWriter({ readEntity: vi.fn().mockResolvedValue({ TotalAmt: 110, DocNumber: 'INV-1' }) });
    const out = await postOnce(t, pid, deps(w));
    expect(out.status).toBe('posted');
    const payload = (w.createEntity as any).mock.calls[0][1];
    expect(payload.TxnTaxDetail).toEqual({ TotalTax: 10, TxnTaxCodeRef: { value: 'TAX1' } });
  });

  it('line-level tax that reconciles posts', async () => {
    const t = await createTenant();
    await activeTaxMapping(t);
    const { pid } = await seedProposal(t, {
      TotalAmt: 110, lines: [{ Amount: 60, description: 'a', accountRef: { value: '60' } }, { Amount: 40, description: 'b', accountRef: { value: '60' } }],
      tax: { mode: 'exclusive', amount: 10, code: 'TAX1', subtotal: 100, lines: [{ amount: 6, code: 'TAX1' }, { amount: 4, code: 'TAX1' }] },
    });
    const w = mockWriter({ readEntity: vi.fn().mockResolvedValue({ TotalAmt: 110, DocNumber: 'INV-1' }) });
    const out = await postOnce(t, pid, deps(w));
    expect(out.status).toBe('posted');
    expect((w.createEntity as any).mock.calls[0][1].TxnTaxDetail.TotalTax).toBe(10);
  });

  it('tax-inclusive invoice posts without silent inclusive→exclusive conversion', async () => {
    const t = await createTenant();
    await activeTaxMapping(t);
    const { pid } = await seedProposal(t, {
      TotalAmt: 110, lines: [{ Amount: 110, description: 'work', accountRef: { value: '60' } }],
      tax: { mode: 'inclusive', amount: 10, code: 'TAX1', subtotal: 110 },
    });
    const w = mockWriter({ readEntity: vi.fn().mockResolvedValue({ TotalAmt: 110, DocNumber: 'INV-1' }) });
    const out = await postOnce(t, pid, deps(w));
    expect(out.status).toBe('posted');
    expect((w.createEntity as any).mock.calls[0][1].TxnTaxDetail.TotalTax).toBe(10);
  });

  it('unsupported/unmapped tax code → held(tax_unmapped) BEFORE create', async () => {
    const t = await createTenant();
    const { pid } = await seedProposal(t, {
      TotalAmt: 110, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }],
      tax: { mode: 'exclusive', amount: 10, subtotal: 100 }, // no code
    });
    const w = mockWriter();
    const out = await postOnce(t, pid, deps(w));
    expect(out.status).toBe('held');
    expect((out as any).reason).toBe('tax_unmapped');
    expect(w.createEntity).not.toHaveBeenCalled();
    expect(await countRows('exceptions', "reason_code='tax_unmapped'")).toBe(1);
  });

  it('non-reconciling total → held(tax_unreconciled) BEFORE create', async () => {
    const t = await createTenant();
    const { pid } = await seedProposal(t, {
      TotalAmt: 200, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }],
      tax: { mode: 'exclusive', amount: 10, code: 'TAX1', subtotal: 100 },
    });
    const w = mockWriter();
    const out = await postOnce(t, pid, deps(w));
    expect(out.status).toBe('held');
    expect((out as any).reason).toBe('tax_unreconciled');
    expect(w.createEntity).not.toHaveBeenCalled();
    expect(await countRows('exceptions', "reason_code='tax_unreconciled'")).toBe(1);
  });
});
