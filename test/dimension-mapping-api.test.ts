import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createSession } from '../src/auth/session.js';
import {
  runListDimensionMappings,
  runAcceptDimensionMapping,
  runCorrectDimensionMapping,
  runSaveRuleDimensionMapping,
  runRejectDimensionMapping,
} from '../src/services/action/index.js';
import { selectAlternateDimensionMapping, type DimensionProviderValidator } from '../src/services/dimensionMappings.js';
import {
  resetTables,
  createTenant,
  createUser,
  createConnection,
  insertProposal,
  insertDimensionMapping,
  countRows,
  closeAll,
} from './helpers.js';

/**
 * F_DIMENSION_MAPPING_API smoke test — mirrors F_TAX_MAPPING_API's test shape: exercises
 * the actual HTTP-layer `run*` action bridges (real auth, real DB, real envelope shape)
 * against a live Postgres, proving: list/filter, accept sets provider_id + review_status,
 * correct updates normalized_value, save-rule creates a scoped `dimension_mapping_rules`
 * row, reject/hold without a reason is 400, non-owner gets 403, cross-tenant access is
 * rejected (404, no leak).
 *
 * `select-alternate` is exercised at the SERVICE layer (`selectAlternateDimensionMapping`)
 * with an injected mock provider validator instead of through the HTTP action bridge: the
 * HTTP bridge wires the REAL QBO validator (`qboDimensionProviderValidator`), and per
 * CLAUDE.md external services (QBO included) are always mocked in the unit-test gate. This
 * still runs the real permission check, real transaction, and real post-write read-back —
 * only the actual QBO network call is swapped for an injected fake, exactly as the
 * `DimensionProviderValidator` parameter is designed for.
 */

async function tokenFor(t: number, role: string, email: string): Promise<{ token: string; userId: number }> {
  const uid = await createUser(t, { role, email });
  return { token: (await createSession(uid)).token, userId: uid };
}
const ownerToken = (t: number) => tokenFor(t, 'owner_controller', 'owner@example.com');
const cpaToken = (t: number) => tokenFor(t, 'cpa', 'cpa@example.com');

function req(method: string, token: string | null, body?: unknown, url = 'http://localhost/api/dimension-mappings'): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function makeFixture(t: number, opts: Parameters<typeof insertDimensionMapping>[3] = {}) {
  const c = await createConnection(t);
  const p = await insertProposal(t);
  const id = await insertDimensionMapping(t, c, p, opts);
  return { connectionId: c, proposalId: p, id };
}

describe('F_DIMENSION_MAPPING_API', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('list filters by dimension_type, review_status, connection, and resolution_state', async () => {
    const t = await createTenant();
    const { token } = await ownerToken(t);
    const { connectionId } = await makeFixture(t, { dimensionType: 'class', reviewStatus: 'pending', resolutionState: 'not_mapped' });
    await makeFixture(t, { dimensionType: 'account', reviewStatus: 'pending', resolutionState: 'not_provided' });

    const byType = await runListDimensionMappings(
      req('GET', token, undefined, `http://localhost/api/dimension-mappings?connectionId=${connectionId}&dimensionType=class`),
    );
    expect(byType.status).toBe(200);
    const byTypeJson = (await byType.json()) as { data: { mappings: Record<string, unknown>[] } };
    expect(byTypeJson.data.mappings.length).toBe(1);
    expect(byTypeJson.data.mappings[0]!.dimension_type).toBe('class');

    const byResolution = await runListDimensionMappings(
      req('GET', token, undefined, 'http://localhost/api/dimension-mappings?resolutionState=not_provided'),
    );
    const byResolutionJson = (await byResolution.json()) as { data: { mappings: Record<string, unknown>[] } };
    expect(byResolutionJson.data.mappings.length).toBe(1);
    expect(byResolutionJson.data.mappings[0]!.resolution_state).toBe('not_provided');
  });

  it('accept sets provider_id from proposed_provider_id and review_status -> accepted', async () => {
    const t = await createTenant();
    const { token } = await ownerToken(t);
    const { id } = await makeFixture(t, {
      dimensionType: 'class', rawValue: 'Marketing', proposedProviderId: '17',
      proposedMatchLabel: 'Marketing Dept', reviewStatus: 'pending', resolutionState: 'not_mapped',
    });

    const res = await runAcceptDimensionMapping(req('POST', token, {}, `http://localhost/api/dimension-mappings/${id}/accept`), id);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { mapping: Record<string, unknown> } };
    expect(json.data.mapping.provider_id).toBe('17');
    expect(json.data.mapping.review_status).toBe('accepted');
    expect(json.data.mapping.resolution_state).toBe('mapped');
    expect(json.data.mapping.mapping_method).toBe('exact');
  });

  it('accept without a proposed_provider_id is rejected (never guesses a mapping)', async () => {
    const t = await createTenant();
    const { token } = await ownerToken(t);
    const { id } = await makeFixture(t, { proposedProviderId: null });

    const res = await runAcceptDimensionMapping(req('POST', token, {}, `http://localhost/api/dimension-mappings/${id}/accept`), id);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('VALIDATION');
  });

  it('select-alternate re-validates against the provider: an invalid choice is rejected, a valid one is written', async () => {
    const t = await createTenant();
    const { userId } = await ownerToken(t);
    const { connectionId, id } = await makeFixture(t, { dimensionType: 'class', rawValue: 'Mktg', reviewStatus: 'pending', resolutionState: 'not_mapped' });
    const ctx = { userId, tenantId: t, role: 'owner_controller', email: 'owner@example.com' };

    const rejects: DimensionProviderValidator = async () => ({ valid: false, detail: 'no active QBO Class matching label' });
    await expect(selectAlternateDimensionMapping(ctx, id, { providerLabel: 'Nonexistent Dept' }, rejects)).rejects.toThrow();
    expect(await countRows('dimension_mappings', 'id=$1 AND provider_id IS NOT NULL', [id])).toBe(0);

    const accepts: DimensionProviderValidator = async (_t, cId, provider, dimType, choice) => {
      expect(cId).toBe(connectionId);
      expect(provider).toBe('qbo');
      expect(dimType).toBe('class');
      expect(choice.providerLabel).toBe('Marketing');
      return { valid: true, providerId: '42' };
    };
    const row = await selectAlternateDimensionMapping(ctx, id, { providerLabel: 'Marketing' }, accepts);
    expect(row.providerId).toBe('42');
    expect(row.reviewStatus).toBe('accepted');
    expect(row.resolutionState).toBe('mapped');
    expect(row.mappingMethod).toBe('manual');
  });

  it('correct updates normalized_value and sets review_status -> corrected', async () => {
    const t = await createTenant();
    const { token } = await ownerToken(t);
    const { id } = await makeFixture(t, { rawValue: 'mktg dept', normalizedValue: null });

    const res = await runCorrectDimensionMapping(
      req('POST', token, { normalizedValue: 'marketing department', reason: 'fixed OCR typo' }, `http://localhost/api/dimension-mappings/${id}/correct`),
      id,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { mapping: Record<string, unknown> } };
    expect(json.data.mapping.normalized_value).toBe('marketing department');
    expect(json.data.mapping.review_status).toBe('corrected');
  });

  it('save-rule creates a dimension_mapping_rules row scoped to tenant+connection+provider+dimension_type', async () => {
    const t = await createTenant();
    const { token } = await ownerToken(t);
    const { connectionId, id } = await makeFixture(t, {
      dimensionType: 'class', rawValue: 'Marketing Dept', normalizedValue: 'marketing dept',
      proposedProviderId: '17', reviewStatus: 'pending', resolutionState: 'not_mapped',
    });
    await runAcceptDimensionMapping(req('POST', token, {}, `http://localhost/api/dimension-mappings/${id}/accept`), id);

    const res = await runSaveRuleDimensionMapping(
      req('POST', token, { reason: 'apply to all future invoices from this vendor' }, `http://localhost/api/dimension-mappings/${id}/save-rule`),
      id,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { rule: Record<string, unknown> } };
    expect(json.data.rule.provider_id).toBe('17');
    expect(json.data.rule.normalized_value).toBe('marketing dept');
    expect(json.data.rule.connection_id).toBe(connectionId);
    expect(
      await countRows(
        'dimension_mapping_rules',
        'tenant_id=$1 AND connection_id=$2 AND provider=$3 AND dimension_type=$4 AND normalized_value=$5 AND active',
        [t, connectionId, 'qbo', 'class', 'marketing dept'],
      ),
    ).toBe(1);
  });

  it('save-rule before the mapping has a resolved provider_id is rejected', async () => {
    const t = await createTenant();
    const { token } = await ownerToken(t);
    const { id } = await makeFixture(t, { providerId: null });

    const res = await runSaveRuleDimensionMapping(req('POST', token, {}, `http://localhost/api/dimension-mappings/${id}/save-rule`), id);
    expect(res.status).toBe(400);
    expect(await countRows('dimension_mapping_rules')).toBe(0);
  });

  it('reject without a reason returns 400; reject with a reason sets review_status -> rejected', async () => {
    const t = await createTenant();
    const { token } = await ownerToken(t);
    const { id } = await makeFixture(t);

    const noReason = await runRejectDimensionMapping(req('POST', token, {}, `http://localhost/api/dimension-mappings/${id}/reject`), id);
    expect(noReason.status).toBe(400);
    const noReasonJson = (await noReason.json()) as { error: { code: string } };
    expect(noReasonJson.error.code).toBe('VALIDATION');

    const rejectRes = await runRejectDimensionMapping(
      req('POST', token, { reason: 'vendor invoice cancelled' }, `http://localhost/api/dimension-mappings/${id}/reject`),
      id,
    );
    expect(rejectRes.status).toBe(200);
    const rejectJson = (await rejectRes.json()) as { data: { mapping: Record<string, unknown> } };
    expect(rejectJson.data.mapping.review_status).toBe('rejected');
  });

  it('hold (status: held) with a reason sets review_status -> held', async () => {
    const t = await createTenant();
    const { token } = await ownerToken(t);
    const { id } = await makeFixture(t);

    const holdRes = await runRejectDimensionMapping(
      req('POST', token, { status: 'held', reason: 'waiting on CPA confirmation' }, `http://localhost/api/dimension-mappings/${id}/reject`),
      id,
    );
    expect(holdRes.status).toBe(200);
    const holdJson = (await holdRes.json()) as { data: { mapping: Record<string, unknown> } };
    expect(holdJson.data.mapping.review_status).toBe('held');
  });

  it('a non-owner (cpa, read-only) gets 403 on accept; zero rows mutated', async () => {
    const t = await createTenant();
    const { token } = await cpaToken(t);
    const { id } = await makeFixture(t, { proposedProviderId: '17' });

    const res = await runAcceptDimensionMapping(req('POST', token, {}, `http://localhost/api/dimension-mappings/${id}/accept`), id);
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('FORBIDDEN');
    expect(await countRows('dimension_mappings', 'id=$1 AND provider_id IS NOT NULL', [id])).toBe(0);
  });

  it('cross-tenant access is rejected: tenant B cannot accept or reject tenant A mapping (404, no leak)', async () => {
    const tA = await createTenant('Tenant A');
    const tB = await createTenant('Tenant B');
    const { token: tokenB } = await ownerToken(tB);
    const { id } = await makeFixture(tA, { proposedProviderId: '17' });

    const acceptAsB = await runAcceptDimensionMapping(req('POST', tokenB, {}, `http://localhost/api/dimension-mappings/${id}/accept`), id);
    expect(acceptAsB.status).toBe(404);

    const rejectAsB = await runRejectDimensionMapping(
      req('POST', tokenB, { reason: 'malicious cross-tenant reject attempt' }, `http://localhost/api/dimension-mappings/${id}/reject`),
      id,
    );
    expect(rejectAsB.status).toBe(404);

    // Untouched — still pending, still owned only by tenant A.
    expect(await countRows('dimension_mappings', "id=$1 AND review_status='pending'", [id])).toBe(1);
  });
});
