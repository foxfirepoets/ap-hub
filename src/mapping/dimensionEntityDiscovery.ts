import { getQboReadClient } from '../qbo/client.js';

/**
 * F_DIMENSION_MAPPING_API — provider dimension-entity discovery/validation. READ-ONLY:
 * uses the existing QBO read client's `queryEntity` only (mirrors `taxCodeDiscovery.ts`;
 * no write/create/update/delete call is added here or anywhere in `src/qbo/client.ts` —
 * guarantee 1). Used by the `select-alternate` flow to confirm a caller-chosen provider
 * value (by id or by label) actually exists in QBO before it is written as `provider_id`.
 */

export interface QboDimensionEntity {
  Id: string;
  Name?: string;
  DisplayName?: string;
  Active?: boolean;
  [k: string]: unknown;
}

// Only dimension_type values with a clear 1:1 QBO list-entity are mapped. Anything else
// (project, job, tracking_category, entity, currency) has no QBO entity to discover
// against today; validation fails closed rather than guessing an entity name.
const QBO_ENTITY_BY_DIMENSION_TYPE: Partial<Record<string, string>> = {
  account: 'Account',
  item: 'Item',
  class: 'Class',
  location: 'Department', // QBO models location tracking via the Department entity.
  department: 'Department',
  customer: 'Customer',
  tax_code: 'TaxCode',
};

export function qboEntityForDimensionType(dimensionType: string): string | null {
  return QBO_ENTITY_BY_DIMENSION_TYPE[dimensionType] ?? null;
}

export async function discoverQboDimensionEntities(
  tenantId: number,
  dimensionType: string,
): Promise<QboDimensionEntity[]> {
  const entityName = qboEntityForDimensionType(dimensionType);
  if (!entityName) return [];
  const client = await getQboReadClient(tenantId);
  return client.queryEntity<QboDimensionEntity>(entityName);
}

/** Adapts QBO discovery to the service layer's provider-agnostic `DimensionProviderValidator` shape. */
export async function qboDimensionProviderValidator(
  tenantId: number,
  _connectionId: number,
  provider: string,
  dimensionType: string,
  choice: { providerId?: string; providerLabel?: string },
): Promise<{ valid: boolean; providerId?: string; detail?: string }> {
  if (provider !== 'qbo') {
    return { valid: false, detail: `alternate-value discovery not implemented for provider '${provider}'` };
  }
  const entityName = qboEntityForDimensionType(dimensionType);
  if (!entityName) {
    return { valid: false, detail: `no QBO entity mapping for dimension_type '${dimensionType}'` };
  }
  const client = await getQboReadClient(tenantId);

  if (choice.providerId) {
    const rows = await client.queryEntity<QboDimensionEntity>(
      entityName,
      `Id = '${choice.providerId.replace(/'/g, "''")}'`,
    );
    const match = rows[0];
    if (!match) return { valid: false, detail: `no QBO ${entityName} with Id ${choice.providerId}` };
    if (match.Active === false) return { valid: false, detail: `QBO ${entityName} ${choice.providerId} is inactive` };
    return { valid: true, providerId: String(match.Id) };
  }

  if (choice.providerLabel) {
    const rows = await client.queryEntity<QboDimensionEntity>(entityName);
    const label = choice.providerLabel.trim().toLowerCase();
    const match = rows.find(
      (r) => (r.Name ?? r.DisplayName ?? '').toString().trim().toLowerCase() === label && r.Active !== false,
    );
    if (!match) return { valid: false, detail: `no active QBO ${entityName} matching label '${choice.providerLabel}'` };
    return { valid: true, providerId: String(match.Id) };
  }

  return { valid: false, detail: 'providerId or providerLabel is required' };
}
