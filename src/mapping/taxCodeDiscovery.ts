import { getQboReadClient } from '../qbo/client.js';

/**
 * F_TAX_MAPPING_API — provider tax-code discovery/validation. READ-ONLY: uses the
 * existing QBO read client's `queryEntity` (no write/create/update/delete call is added
 * here or anywhere in `src/qbo/client.ts` — guarantee 1). Used by the tax-mapping
 * `create`/`revalidate` flows to confirm a provider_tax_code actually exists before an
 * operator maps to it, and by GET /api/tax-mappings/discover for browse/pick UIs.
 */

export interface QboTaxCode {
  Id: string;
  Name?: string;
  Description?: string;
  Active?: boolean;
  [k: string]: unknown;
}

export async function discoverQboTaxCodes(tenantId: number): Promise<QboTaxCode[]> {
  const client = await getQboReadClient(tenantId);
  return client.queryEntity<QboTaxCode>('TaxCode');
}

export async function validateQboTaxCode(
  tenantId: number,
  code: string,
): Promise<{ valid: boolean; detail?: string; taxCode?: QboTaxCode }> {
  const client = await getQboReadClient(tenantId);
  const rows = await client.queryEntity<QboTaxCode>('TaxCode', `Id = '${code.replace(/'/g, "''")}'`);
  const match = rows[0];
  if (!match) return { valid: false, detail: `no QBO TaxCode with Id ${code}` };
  if (match.Active === false) return { valid: false, detail: `QBO TaxCode ${code} is inactive`, taxCode: match };
  return { valid: true, taxCode: match };
}

/** Adapts `validateQboTaxCode` to the service layer's provider-agnostic `ProviderCodeValidator` shape. */
export async function qboProviderCodeValidator(
  tenantId: number,
  _connectionId: number,
  provider: string,
  providerTaxCode: string,
): Promise<{ valid: boolean; detail?: string }> {
  if (provider !== 'qbo') {
    return { valid: false, detail: `revalidation not implemented for provider '${provider}'` };
  }
  const res = await validateQboTaxCode(tenantId, providerTaxCode);
  return { valid: res.valid, detail: res.detail };
}
