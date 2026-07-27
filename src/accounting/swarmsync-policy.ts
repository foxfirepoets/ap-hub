import { query } from '../db/pool.js';

/**
 * Per-company SwarmSync verification policy (architecture-decision-packet §5,
 * "SwarmSync optional-consent design"). Stored in `connections.metadata` — the
 * same JSONB column `ownerWriteGate` already uses (src/accounting/write-gates.ts)
 * — so no schema migration is needed. Absent/invalid value defaults to
 * 'optional' (rule 1: SwarmSync is optional for a company unless explicitly
 * configured otherwise).
 */
export type SwarmSyncPolicy = 'optional' | 'required';

function normalizePolicy(metadata: Record<string, unknown> | null | undefined): SwarmSyncPolicy {
  const value = (metadata ?? {})['swarmSyncPolicy'];
  return value === 'required' ? 'required' : 'optional';
}

/** Policy for a specific connection, identified the same way the tax-mapping gate looks
 *  up connections in src/pipeline/posting.ts: (tenant, provider, external_company). */
export async function getSwarmSyncPolicyForConnection(
  tenantId: number,
  provider: string,
  externalCompany: string,
): Promise<SwarmSyncPolicy> {
  const row = (
    await query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM connections WHERE tenant_id=$1 AND provider=$2 AND external_company=$3',
      [tenantId, provider, externalCompany],
    )
  ).rows[0];
  return normalizePolicy(row?.metadata);
}

/** Policy for a tenant when no specific connector/company is at hand (e.g. the
 *  gatekeeper, which acts on Gmail before any accounting connector is involved) —
 *  same tenant-scoped "active connection" lookup used in
 *  src/mapping/dimensionMappingStore.ts. */
export async function getSwarmSyncPolicyForTenant(tenantId: number): Promise<SwarmSyncPolicy> {
  const row = (
    await query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM connections WHERE tenant_id=$1 AND status='active' ORDER BY id ASC LIMIT 1`,
      [tenantId],
    )
  ).rows[0];
  return normalizePolicy(row?.metadata);
}
