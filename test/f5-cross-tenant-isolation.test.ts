import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createSession } from '../src/auth/session.js';
import { postOnce } from '../src/pipeline/posting.js';
import { query } from '../src/db/pool.js';
import { recordProofRef } from '../src/swarmsync/proof.js';
import {
  runListTaxMappings,
  runCreateTaxMapping,
  runDisableTaxMapping,
  runReplaceTaxMapping,
  runListDimensionMappings,
  runAcceptDimensionMapping,
  runCorrectDimensionMapping,
  runSaveRuleDimensionMapping,
} from '../src/services/action/index.js';
import { revalidateTaxMapping, type ProviderCodeValidator } from '../src/services/taxMappings.js';
import { selectAlternateDimensionMapping, type DimensionProviderValidator } from '../src/services/dimensionMappings.js';
import {
  resetTables, createTenant, createUser, createConnection, insertMessage, insertAttachment,
  insertExtraction, insertProposal, insertDimensionMapping, countRows, closeAll,
} from './helpers.js';
import { mockConnector } from './connector-mock.js';

/**
 * F5-cross-tenant-isolation — exhaustive proof that a tax_mapping or dimension_mapping
 * scoped to tenant A/connection A is NEVER visible, matchable, or reusable by tenant B/
 * connection B, even when both tenants use the identical provider ('qbo') and even the
 * identical external_company string. This fills gaps `tax-mapping-api.test.ts` and
 * `dimension-mapping-api.test.ts` did not cover: list, disable, replace, revalidate,
 * select-alternate, correct, save-rule, and — most importantly — the live posting-gate
 * lookup in `src/pipeline/posting.ts` (a leak there would post the WRONG tax code).
 */

async function tokenFor(t: number, role: string, email: string): Promise<{ token: string; userId: number }> {
  const uid = await createUser(t, { role, email });
  return { token: (await createSession(uid)).token, userId: uid };
}
const ownerToken = (t: number, email = 'owner@example.com') => tokenFor(t, 'owner_controller', email);

function req(method: string, token: string | null, body?: unknown, url = 'http://localhost/api/tax-mappings'): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const createBody = (connectionId: number, code = 'TAX8') => ({
  connectionId,
  provider: 'qbo',
  providerTaxCode: code,
  internalTaxTreatment: 'standard_sales_tax',
  taxMode: 'exclusive',
});

describe('F5 cross-tenant isolation — tax_mappings', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('list scoped by connectionId never returns another tenant\'s rows even for the same provider+code', async () => {
    const tA = await createTenant('Tenant A');
    const tB = await createTenant('Tenant B');
    const { token: tokenA } = await ownerToken(tA);
    const { token: tokenB } = await ownerToken(tB);
    const cA = await createConnection(tA, { provider: 'qbo', externalCompany: 'shared-co-name' });
    const cB = await createConnection(tB, { provider: 'qbo', externalCompany: 'shared-co-name' });
    await runCreateTaxMapping(req('POST', tokenA, createBody(cA, 'TAX8')));
    await runCreateTaxMapping(req('POST', tokenB, createBody(cB, 'TAX8')));

    // Tenant B listing by its OWN connection id sees only its own row.
    const listB = await runListTaxMappings(req('GET', tokenB, undefined, `http://localhost/api/tax-mappings?connectionId=${cB}&filter=all`));
    const listBJson = (await listB.json()) as { data: { mappings: Record<string, unknown>[] } };
    expect(listBJson.data.mappings.length).toBe(1);
    expect(listBJson.data.mappings[0]!.connection_id).toBe(cB);

    // Tenant B querying tenant A's connectionId (guessed id) returns nothing — not A's row.
    const listBGuessA = await runListTaxMappings(req('GET', tokenB, undefined, `http://localhost/api/tax-mappings?connectionId=${cA}&filter=all`));
    const listBGuessAJson = (await listBGuessA.json()) as { data: { mappings: unknown[] } };
    expect(listBGuessAJson.data.mappings.length).toBe(0);

    // Unfiltered list (no connectionId) for B never includes A's row.
    const listBAll = await runListTaxMappings(req('GET', tokenB, undefined, 'http://localhost/api/tax-mappings?filter=all'));
    const listBAllJson = (await listBAll.json()) as { data: { mappings: Record<string, unknown>[] } };
    expect(listBAllJson.data.mappings.every((m) => m.connection_id === cB)).toBe(true);
  });

  it('disable and replace on a foreign id both 404, and leave the row untouched', async () => {
    const tA = await createTenant('Tenant A');
    const tB = await createTenant('Tenant B');
    const { token: tokenA } = await ownerToken(tA);
    const { token: tokenB } = await ownerToken(tB);
    const cA = await createConnection(tA, { provider: 'qbo' });
    const created = ((await (await runCreateTaxMapping(req('POST', tokenA, createBody(cA)))).json()) as any).data.mapping;

    const disableAsB = await runDisableTaxMapping(
      req('POST', tokenB, { reason: 'cross-tenant attempt' }, `http://localhost/api/tax-mappings/${created.id}/disable`),
      created.id,
    );
    expect(disableAsB.status).toBe(404);

    const replaceAsB = await runReplaceTaxMapping(
      req('POST', tokenB, { internalTaxTreatment: 'x', taxMode: 'inclusive', reason: 'cross-tenant attempt' }, `http://localhost/api/tax-mappings/${created.id}/replace`),
      created.id,
    );
    expect(replaceAsB.status).toBe(404);

    expect(await countRows('tax_mappings', 'id=$1 AND active', [created.id])).toBe(1);
    expect(await countRows('tax_mapping_audit', 'tax_mapping_id=$1', [created.id])).toBe(1); // only the original create
  });

  it('revalidate (service layer, injected validator) rejects a foreign id — never touches another tenant\'s row', async () => {
    const tA = await createTenant('Tenant A');
    const tB = await createTenant('Tenant B');
    const { userId: userA } = await ownerToken(tA);
    const { userId: userB } = await ownerToken(tB);
    const cA = await createConnection(tA, { provider: 'qbo' });
    const ctxA = { userId: userA, tenantId: tA, role: 'owner_controller', email: 'owner@example.com' };
    const ctxB = { userId: userB, tenantId: tB, role: 'owner_controller', email: 'owner@example.com' };

    const created = await (
      await import('../src/services/taxMappings.js')
    ).createTaxMapping(ctxA, {
      connectionId: cA, provider: 'qbo', providerTaxCode: 'TAX8',
      internalTaxTreatment: 'standard', taxMode: 'exclusive', reason: 'init',
    });

    const alwaysValid: ProviderCodeValidator = vi.fn().mockResolvedValue({ valid: true });
    await expect(revalidateTaxMapping(ctxB, created.id, {}, alwaysValid)).rejects.toThrow();
    expect(alwaysValid).not.toHaveBeenCalled(); // never even reaches the provider check for a foreign id
    expect(await countRows('tax_mapping_audit', "tax_mapping_id=$1 AND action='revalidate'", [created.id])).toBe(0);
  });

  it('POSTING GATE: tenant B never inherits tenant A\'s active tax_mapping, even with an identical provider+company', async () => {
    const tA = await createTenant('Tenant A');
    const tB = await createTenant('Tenant B');
    await createConnection(tA, { provider: 'qbo', externalCompany: 'sandbox-realm' });
    await createConnection(tB, { provider: 'qbo', externalCompany: 'sandbox-realm' });
    const { userId: userA } = await ownerToken(tA);
    const ctxA = { userId: userA, tenantId: tA, role: 'owner_controller', email: 'owner@example.com' };
    const { createTaxMapping } = await import('../src/services/taxMappings.js');
    const connARow = (await query<{ id: number }>('SELECT id FROM connections WHERE tenant_id=$1', [tA])).rows[0]!.id;
    await createTaxMapping(ctxA, {
      connectionId: connARow, provider: 'qbo', providerTaxCode: 'TAX1',
      internalTaxTreatment: 'standard', taxMode: 'exclusive', reason: 'init',
    });

    // Build a ready proposal for tenant B carrying the SAME tax code as tenant A's mapping.
    const m = await insertMessage(tB);
    const a = await insertAttachment(tB, m, { sha256: `sha-${tB}-${Math.floor(performance.now())}` });
    const sha = (await query<{ sha256: string }>('SELECT sha256 FROM attachments WHERE id=$1', [a])).rows[0]!.sha256;
    const e = await insertExtraction(tB, m, a, {}, 0.95);
    await recordProofRef({ tenantId: tB, entityKind: 'extraction', entityId: String(e), product: 'verify_api', proofId: 'p', chainHash: 'h' });
    const txn = {
      txnType: 'Bill', vendorRef: { value: 'V1', name: 'Acme' }, DocNumber: 'INV-1', TxnDate: '2026-07-01',
      TotalAmt: 108, lines: [{ Amount: 100, description: 'work', accountRef: { value: '60' } }],
      tax: { mode: 'exclusive', amount: 8, code: 'TAX1', subtotal: 100 },
    };
    const pid = (
      await query<{ id: number }>(
        `INSERT INTO proposals (tenant_id, attachment_id, extraction_id, proposed_txn, idempotency_key, confidence, status, flags)
         VALUES ($1,$2,$3,$4,$5,0.95,'ready','{}') RETURNING id`,
        [tB, a, e, JSON.stringify(txn), sha],
      )
    ).rows[0]!.id;
    await recordProofRef({ tenantId: tB, entityKind: 'proposal', entityId: String(pid), product: 'invoiceproof', verdict: 'clean' });

    const w = mockConnector();
    const out = await postOnce(tB, pid, { connector: w, anchor: vi.fn(), loadPdf: async () => null, amountCeiling: 10000, autoThreshold: 0.9 });
    expect(out.status).toBe('held');
    expect((out as any).reason).toBe('tax_mapping_not_found'); // A's active mapping never leaks into B's gate
    expect(w.postBill).not.toHaveBeenCalled();

    // Once tenant B configures its OWN mapping for the same code, it posts.
    const connBRow = (await query<{ id: number }>('SELECT id FROM connections WHERE tenant_id=$1', [tB])).rows[0]!.id;
    await query(
      `INSERT INTO tax_mappings (tenant_id, connection_id, provider, provider_tax_code, internal_tax_treatment, tax_mode, active, needs_revalidation)
       VALUES ($1,$2,'qbo','TAX1','Standard','exclusive',true,false)`,
      [tB, connBRow],
    );
    const out2 = await postOnce(tB, pid, { connector: w, anchor: vi.fn().mockResolvedValue({ proof_id: 'p', chain_hash: 'c', verification_status: 'passed', confidence: 1, raw: {} }), loadPdf: async () => null, amountCeiling: 10000, autoThreshold: 0.9 });
    expect(out2.status).toBe('posted');
  });
});

describe('F5 cross-tenant isolation — dimension_mappings', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  async function makeFixture(t: number, opts: Parameters<typeof insertDimensionMapping>[3] = {}) {
    const c = await createConnection(t, { provider: 'qbo' });
    const p = await insertProposal(t);
    const id = await insertDimensionMapping(t, c, p, opts);
    return { connectionId: c, proposalId: p, id };
  }

  it('list never mixes rows across tenants for the same provider+dimension_type', async () => {
    const tA = await createTenant('Tenant A');
    const tB = await createTenant('Tenant B');
    const { token: tokenB } = await ownerToken(tB);
    await makeFixture(tA, { dimensionType: 'class', rawValue: 'Marketing' });
    const fixB = await makeFixture(tB, { dimensionType: 'class', rawValue: 'Marketing' });

    const listB = await runListDimensionMappings(req('GET', tokenB, undefined, 'http://localhost/api/dimension-mappings?dimensionType=class'));
    const listBJson = (await listB.json()) as { data: { mappings: Record<string, unknown>[] } };
    expect(listBJson.data.mappings.length).toBe(1);
    expect(listBJson.data.mappings[0]!.id).toBe(fixB.id);
  });

  it('select-alternate rejects a foreign id before ever calling the provider validator', async () => {
    const tA = await createTenant('Tenant A');
    const tB = await createTenant('Tenant B');
    const { userId: userB } = await ownerToken(tB);
    const { id } = await makeFixture(tA, { dimensionType: 'class', rawValue: 'Mktg' });
    const ctxB = { userId: userB, tenantId: tB, role: 'owner_controller', email: 'owner@example.com' };

    const validate: DimensionProviderValidator = vi.fn().mockResolvedValue({ valid: true, providerId: '99' });
    await expect(selectAlternateDimensionMapping(ctxB, id, { providerLabel: 'Marketing' }, validate)).rejects.toThrow();
    expect(validate).not.toHaveBeenCalled();
    expect(await countRows('dimension_mappings', 'id=$1 AND provider_id IS NOT NULL', [id])).toBe(0);
  });

  it('correct and save-rule both reject a foreign id (404), never mutate the row', async () => {
    const tA = await createTenant('Tenant A');
    const tB = await createTenant('Tenant B');
    const { token: tokenB } = await ownerToken(tB);
    const { id } = await makeFixture(tA, { dimensionType: 'class', rawValue: 'Mktg', proposedProviderId: '17' });

    const correctAsB = await runCorrectDimensionMapping(
      req('POST', tokenB, { normalizedValue: 'hijacked', reason: 'cross-tenant' }, `http://localhost/api/dimension-mappings/${id}/correct`),
      id,
    );
    expect(correctAsB.status).toBe(404);

    const saveRuleAsB = await runSaveRuleDimensionMapping(req('POST', tokenB, {}, `http://localhost/api/dimension-mappings/${id}/save-rule`), id);
    expect(saveRuleAsB.status).toBe(404);

    expect(await countRows('dimension_mappings', "id=$1 AND normalized_value IS NULL", [id])).toBe(1);
    expect(await countRows('dimension_mapping_rules')).toBe(0);
  });

  it('an active dimension_mapping_rule for tenant A never blocks tenant B from creating the identical rule', async () => {
    const tA = await createTenant('Tenant A');
    const tB = await createTenant('Tenant B');
    const { token: tokenA } = await ownerToken(tA);
    const { token: tokenB } = await ownerToken(tB);
    const fixA = await makeFixture(tA, {
      dimensionType: 'class', rawValue: 'Marketing Dept', normalizedValue: 'marketing dept',
      proposedProviderId: '17', reviewStatus: 'pending', resolutionState: 'not_mapped',
    });
    await runAcceptDimensionMapping(req('POST', tokenA, {}, `http://localhost/api/dimension-mappings/${fixA.id}/accept`), fixA.id);
    await runSaveRuleDimensionMapping(req('POST', tokenA, { reason: 'A rule' }, `http://localhost/api/dimension-mappings/${fixA.id}/save-rule`), fixA.id);

    // Same provider, same dimension_type, same normalized_value, but tenant B — must NOT collide.
    const fixB = await makeFixture(tB, {
      dimensionType: 'class', rawValue: 'Marketing Dept', normalizedValue: 'marketing dept',
      proposedProviderId: '99', reviewStatus: 'pending', resolutionState: 'not_mapped',
    });
    await runAcceptDimensionMapping(req('POST', tokenB, {}, `http://localhost/api/dimension-mappings/${fixB.id}/accept`), fixB.id);
    const saveRuleB = await runSaveRuleDimensionMapping(
      req('POST', tokenB, { reason: 'B rule' }, `http://localhost/api/dimension-mappings/${fixB.id}/save-rule`),
      fixB.id,
    );
    expect(saveRuleB.status).toBe(201);
    expect(await countRows('dimension_mapping_rules', "tenant_id=$1 AND normalized_value='marketing dept'", [tA])).toBe(1);
    expect(await countRows('dimension_mapping_rules', "tenant_id=$1 AND normalized_value='marketing dept'", [tB])).toBe(1);
  });
});
