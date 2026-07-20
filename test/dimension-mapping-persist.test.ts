import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { proposeOnce } from '../src/pipeline/mapping.js';
import { postOnce } from '../src/pipeline/posting.js';
import { query } from '../src/db/pool.js';
import { recordProofRef } from '../src/swarmsync/proof.js';
import { createQboConnector } from '../src/connectors/qbo.js';
import type { QboWriteClient } from '../src/qbo/write.js';
import type { QboReadClient } from '../src/qbo/client.js';
import {
  resetTables, createTenant, createConnection,
  insertMessage, insertAttachment, insertExtraction, closeAll,
} from './helpers.js';

/**
 * FIX-propose-time-dimension-population: proves the map/propose stage (src/pipeline/mapping.ts)
 * itself writes the dimension_mappings row the posting-time fail-closed gate reads
 * (src/pipeline/posting.ts ~L168-190) — no test-only manual insert. Three states from
 * src/mapping/dimensions.ts toDimensionMappingInsert(): mapped/accepted (posts), not_mapped/pending
 * (holds), intentionally_blank (passes through blank).
 */

const proposeDeps = (scan: any) => ({ scan, autoThreshold: 0.9, reviewThreshold: 0.6 });
const cleanScan = async () => ({ findings: [], raw: {} });

function mockRead(): QboReadClient {
  return { getCompanyInfo: vi.fn().mockResolvedValue({ CompanyName: 'Sandbox' }), queryEntity: vi.fn().mockResolvedValue([]) } as unknown as QboReadClient;
}
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
const postDeps = (writer: QboWriteClient) => ({
  connector: createQboConnector({ writeClient: writer, readClient: mockRead() }),
  anchor: okAnchor,
  loadPdf: async () => Buffer.from('%PDF'),
  amountCeiling: 10000,
  autoThreshold: 0.9,
});

async function seedVendorAndAccount(t: number) {
  await query(
    `INSERT INTO mappings (tenant_id, kind, source_key, target_qbo_id, target_name)
     VALUES ($1,'vendor','acme','V1','Acme'), ($1,'account','work','60','Subcontractors')`,
    [t],
  );
}

async function seedReadyExtraction(t: number, fields: Record<string, unknown>) {
  const m = await insertMessage(t);
  const a = await insertAttachment(t, m);
  const e = await insertExtraction(t, m, a, fields, 0.95);
  await recordProofRef({ tenantId: t, entityKind: 'extraction', entityId: String(e), product: 'verify_api', proofId: 'p', chainHash: 'h' });
  return { m, a, e };
}

async function dimRow(t: number, proposalId: number, dimensionType: string) {
  const { rows } = await query<any>(
    'SELECT * FROM dimension_mappings WHERE tenant_id=$1 AND proposal_id=$2 AND dimension_type=$3',
    [t, proposalId, dimensionType],
  );
  return rows[0] ?? null;
}

describe('propose-time dimension_mappings persistence', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('(a) high-confidence dimension -> mapped/accepted row, posts through the fail-closed gate without holding', async () => {
    const t = await createTenant();
    const connId = await createConnection(t);
    await seedVendorAndAccount(t);
    await query(
      `INSERT INTO mappings (tenant_id, kind, source_key, target_qbo_id, target_name) VALUES ($1,'class','west','CL1','West')`,
      [t],
    );
    const { a, e } = await seedReadyExtraction(t, { class_hint: 'West' });
    const out = await proposeOnce(t, { tenantId: t, extractionId: e, attachmentId: a, messageId: 0 }, proposeDeps(cleanScan));
    expect(out?.status).toBe('ready');

    const row = await dimRow(t, out!.proposalId, 'class');
    expect(row).toMatchObject({
      connection_id: connId,
      provider: 'qbo',
      dimension_type: 'class',
      raw_value: 'West',
      provider_id: 'CL1',
      mapping_method: 'exact',
      review_status: 'accepted',
      resolution_state: 'mapped',
    });

    const w = mockWriter({
      readEntity: vi.fn().mockResolvedValue({
        TotalAmt: 100, DocNumber: 'INV-1',
        Line: [{ AccountBasedExpenseLineDetail: { ClassRef: { value: 'CL1' } } }],
      }),
    });
    const posted = await postOnce(t, out!.proposalId, postDeps(w));
    expect(posted.status).toBe('posted');
  });

  it('(b) unresolved dimension -> not_mapped/pending row; the posting gate holds on it', async () => {
    const t = await createTenant();
    await createConnection(t);
    await seedVendorAndAccount(t);
    const { a, e } = await seedReadyExtraction(t, { class_hint: 'Nonexistent Division' });
    const out = await proposeOnce(t, { tenantId: t, extractionId: e, attachmentId: a, messageId: 0 }, proposeDeps(cleanScan));
    // unmapped_dimension is a blocking flag at propose time — never auto-ready.
    expect(out?.status).toBe('exception');

    const row = await dimRow(t, out!.proposalId, 'class');
    expect(row).toMatchObject({
      dimension_type: 'class',
      raw_value: 'Nonexistent Division',
      review_status: 'pending',
      resolution_state: 'not_mapped',
    });
    expect(row.provider_id).toBeNull();

    // Exercise the posting-time fail-closed dimension gate directly against the persisted
    // row (simulating an operator override that force-readies the proposal). Flags are
    // cleared too, so this isolates the dimension_mappings gate from the earlier
    // blocking_flag check (unmapped_dimension) that would otherwise short-circuit first —
    // proving the persisted row alone is enough to hold.
    await query("UPDATE proposals SET status='ready', flags='{}' WHERE tenant_id=$1 AND id=$2", [t, out!.proposalId]);
    const posted = await postOnce(t, out!.proposalId, postDeps(mockWriter()));
    expect(posted.status).toBe('held');
    expect((posted as any).reason).toBe('dimension_mapping_not_mapped');
  });

  it('(c) absent optional dimension (intentionally blank) -> intentionally_blank row, passes through', async () => {
    const t = await createTenant();
    await createConnection(t);
    await seedVendorAndAccount(t);
    const { a, e } = await seedReadyExtraction(t, { class_hint: '' });
    const out = await proposeOnce(t, { tenantId: t, extractionId: e, attachmentId: a, messageId: 0 }, proposeDeps(cleanScan));
    expect(out?.status).toBe('ready');

    const row = await dimRow(t, out!.proposalId, 'class');
    expect(row).toMatchObject({
      dimension_type: 'class',
      raw_value: '',
      resolution_state: 'intentionally_blank',
    });

    const posted = await postOnce(t, out!.proposalId, postDeps(mockWriter()));
    expect(posted.status).toBe('posted');
  });
});
