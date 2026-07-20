import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createSession } from '../src/auth/session.js';
import {
  runListTaxMappings,
  runCreateTaxMapping,
  runGetTaxMapping,
  runEditTaxMapping,
  runDisableTaxMapping,
  runReplaceTaxMapping,
  runGetTaxMappingAudit,
} from '../src/services/action/index.js';
import { resetTables, createTenant, createUser, createConnection, countRows, closeAll } from './helpers.js';

/**
 * F_TAX_MAPPING_API smoke test — exercises the actual HTTP-layer `run*` action bridges
 * (real auth, real DB, real envelope shape) against a live Postgres, proving:
 *   create -> read-back matches; edit requires reason; disable sets active=false + audit
 *   row; replace creates a new row + marks the old superseded; non-owner gets 403;
 *   cross-tenant access is rejected (404, never a foreign row).
 * Full exhaustive coverage is a separate downstream task — this proves the endpoints
 * function end-to-end.
 */

async function tokenFor(t: number, role: string, email: string): Promise<string> {
  const uid = await createUser(t, { role, email });
  return (await createSession(uid)).token;
}
const ownerToken = (t: number) => tokenFor(t, 'owner_controller', 'owner@example.com');
const cpaToken = (t: number) => tokenFor(t, 'cpa', 'cpa@example.com');

function req(method: string, token: string | null, body?: unknown, url = 'http://localhost/api/tax-mappings'): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const createBody = (connectionId: number) => ({
  connectionId,
  provider: 'qbo',
  providerTaxCode: 'TAX8',
  internalTaxTreatment: 'standard_sales_tax',
  taxMode: 'exclusive',
});

describe('F_TAX_MAPPING_API', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('create -> read-back matches exactly what was posted', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    const c = await createConnection(t);

    const createRes = await runCreateTaxMapping(req('POST', token, createBody(c)));
    expect(createRes.status).toBe(201);
    const createJson = (await createRes.json()) as { data: { mapping: Record<string, unknown> } };
    const created = createJson.data.mapping;
    expect(created.provider_tax_code).toBe('TAX8');
    expect(created.tax_mode).toBe('exclusive');
    expect(created.active).toBe(true);

    const getRes = await runGetTaxMapping(req('GET', token, undefined), Number(created.id));
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as { data: { mapping: Record<string, unknown> } };
    expect(getJson.data.mapping).toEqual(created);

    expect(await countRows('tax_mapping_audit', "action='create' AND tax_mapping_id=$1", [created.id])).toBe(1);
  });

  it('edit without a reason is rejected 400; edit with a reason sets needs_revalidation', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    const c = await createConnection(t);
    const created = ((await (await runCreateTaxMapping(req('POST', token, createBody(c)))).json()) as any).data.mapping;

    const noReasonRes = await runEditTaxMapping(
      req('POST', token, { internalTaxTreatment: 'reduced_sales_tax' }, `http://localhost/api/tax-mappings/${created.id}/edit`),
      created.id,
    );
    expect(noReasonRes.status).toBe(400);
    const noReasonJson = (await noReasonRes.json()) as { error: { code: string } };
    expect(noReasonJson.error.code).toBe('VALIDATION');

    const editRes = await runEditTaxMapping(
      req(
        'POST',
        token,
        { internalTaxTreatment: 'reduced_sales_tax', reason: 'rate correction from CPA review' },
        `http://localhost/api/tax-mappings/${created.id}/edit`,
      ),
      created.id,
    );
    expect(editRes.status).toBe(200);
    const editJson = (await editRes.json()) as { data: { mapping: Record<string, unknown> } };
    expect(editJson.data.mapping.internal_tax_treatment).toBe('reduced_sales_tax');
    expect(editJson.data.mapping.needs_revalidation).toBe(true);
    expect(await countRows('tax_mapping_audit', "action='edit' AND reason=$1", ['rate correction from CPA review'])).toBe(1);
  });

  it('disable sets active=false and writes an audit row', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    const c = await createConnection(t);
    const created = ((await (await runCreateTaxMapping(req('POST', token, createBody(c)))).json()) as any).data.mapping;

    const noReason = await runDisableTaxMapping(req('POST', token, {}, `http://localhost/api/tax-mappings/${created.id}/disable`), created.id);
    expect(noReason.status).toBe(400);

    const disableRes = await runDisableTaxMapping(
      req('POST', token, { reason: 'code retired by state' }, `http://localhost/api/tax-mappings/${created.id}/disable`),
      created.id,
    );
    expect(disableRes.status).toBe(200);
    const disableJson = (await disableRes.json()) as { data: { mapping: Record<string, unknown> } };
    expect(disableJson.data.mapping.active).toBe(false);
    expect(await countRows('tax_mapping_audit', "action='disable' AND tax_mapping_id=$1", [created.id])).toBe(1);
  });

  it('replace creates a new row and marks the old one superseded', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    const c = await createConnection(t);
    const created = ((await (await runCreateTaxMapping(req('POST', token, createBody(c)))).json()) as any).data.mapping;

    const replaceRes = await runReplaceTaxMapping(
      req(
        'POST',
        token,
        { internalTaxTreatment: 'standard_sales_tax_v2', taxMode: 'inclusive', reason: 'provider changed tax-code semantics' },
        `http://localhost/api/tax-mappings/${created.id}/replace`,
      ),
      created.id,
    );
    expect(replaceRes.status).toBe(201);
    const replaceJson = (await replaceRes.json()) as { data: { old: Record<string, unknown>; replacement: Record<string, unknown> } };
    expect(replaceJson.data.old.active).toBe(false);
    expect(replaceJson.data.old.superseded_by_id).toBe(replaceJson.data.replacement.id);
    expect(replaceJson.data.replacement.active).toBe(true);
    expect(replaceJson.data.replacement.tax_mode).toBe('inclusive');
    expect(await countRows('tax_mappings', 'connection_id=$1', [c])).toBe(2);
    expect(await countRows('tax_mapping_audit', "action='replace' AND tax_mapping_id=$1", [created.id])).toBe(1);
  });

  it('a non-owner (cpa, read-only) gets 403 on create; zero rows written', async () => {
    const t = await createTenant();
    const token = await cpaToken(t);
    const c = await createConnection(t);
    const res = await runCreateTaxMapping(req('POST', token, createBody(c)));
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('FORBIDDEN');
    expect(await countRows('tax_mappings')).toBe(0);
  });

  it('cross-tenant access is rejected: tenant B cannot read or edit tenant A mapping (404, no leak)', async () => {
    const tA = await createTenant('Tenant A');
    const tB = await createTenant('Tenant B');
    const tokenA = await ownerToken(tA);
    const tokenB = await ownerToken(tB);
    const cA = await createConnection(tA);
    const created = ((await (await runCreateTaxMapping(req('POST', tokenA, createBody(cA)))).json()) as any).data.mapping;

    const getAsB = await runGetTaxMapping(req('GET', tokenB, undefined), created.id);
    expect(getAsB.status).toBe(404);

    const editAsB = await runEditTaxMapping(
      req('POST', tokenB, { reason: 'malicious cross-tenant edit attempt' }, `http://localhost/api/tax-mappings/${created.id}/edit`),
      created.id,
    );
    expect(editAsB.status).toBe(404);

    // The mapping is untouched — still active, still owned by tenant A only.
    const getAsA = await runGetTaxMapping(req('GET', tokenA, undefined), created.id);
    expect(getAsA.status).toBe(200);
    const getAsAJson = (await getAsA.json()) as { data: { mapping: Record<string, unknown> } };
    expect(getAsAJson.data.mapping.active).toBe(true);
  });

  it('GET /:id/audit returns real rows with reason populated; cross-tenant access is rejected 404', async () => {
    const tA = await createTenant('Tenant A');
    const tB = await createTenant('Tenant B');
    const tokenA = await ownerToken(tA);
    const tokenB = await ownerToken(tB);
    const cA = await createConnection(tA);
    const created = ((await (await runCreateTaxMapping(req('POST', tokenA, createBody(cA)))).json()) as any).data.mapping;
    await runEditTaxMapping(
      req('POST', tokenA, { internalTaxTreatment: 'reduced_sales_tax', reason: 'rate correction from CPA review' }, `http://localhost/api/tax-mappings/${created.id}/edit`),
      created.id,
    );

    const auditRes = await runGetTaxMappingAudit(req('GET', tokenA, undefined, `http://localhost/api/tax-mappings/${created.id}/audit`), created.id);
    expect(auditRes.status).toBe(200);
    const auditJson = (await auditRes.json()) as { data: { audit: Record<string, unknown>[] } };
    expect(auditJson.data.audit.length).toBe(2);
    expect(auditJson.data.audit[0]?.action).toBe('create');
    expect(auditJson.data.audit[1]?.action).toBe('edit');
    expect(auditJson.data.audit[1]?.reason).toBe('rate correction from CPA review');

    const auditAsB = await runGetTaxMappingAudit(req('GET', tokenB, undefined, `http://localhost/api/tax-mappings/${created.id}/audit`), created.id);
    expect(auditAsB.status).toBe(404);
  });

  it('list filters by connection and by exception (needs_revalidation)', async () => {
    const t = await createTenant();
    const token = await ownerToken(t);
    const c = await createConnection(t);
    const created = ((await (await runCreateTaxMapping(req('POST', token, createBody(c)))).json()) as any).data.mapping;
    await runEditTaxMapping(
      req('POST', token, { reason: 'flip to exception state' }, `http://localhost/api/tax-mappings/${created.id}/edit`),
      created.id,
    );

    const activeList = await runListTaxMappings(req('GET', token, undefined, `http://localhost/api/tax-mappings?connectionId=${c}&filter=active`));
    const activeJson = (await activeList.json()) as { data: { mappings: unknown[] } };
    expect(activeJson.data.mappings.length).toBe(1);

    const exceptionList = await runListTaxMappings(
      req('GET', token, undefined, `http://localhost/api/tax-mappings?connectionId=${c}&filter=exception`),
    );
    const exceptionJson = (await exceptionList.json()) as { data: { mappings: unknown[] } };
    expect(exceptionJson.data.mappings.length).toBe(1);
  });
});
