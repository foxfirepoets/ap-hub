import type pg from 'pg';
import { query } from './pool.js';

/**
 * Tenant-scoped query helper (CHUNK_1_AUTH). Guarantee 6 / spec §14: no query may
 * cross tenants. Callers pass the resolved `tenantId` as the first argument; it is
 * bound to `$1`, and the SQL MUST reference `tenant_id` for scoping. Both a missing
 * tenant id and a query that forgot its tenant filter throw — a leak is a crash, not
 * a silent cross-tenant read.
 *
 *   scopedQuery(ctx.tenantId, 'SELECT * FROM proposals WHERE tenant_id = $1 AND id = $2', [id])
 */
export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}

export async function scopedQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  tenantId: number,
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  // pg returns bigint columns as strings, so a resolved tenant_id may arrive as a
  // numeric string. Accept either form; reject only missing/non-positive-integer ids.
  const n = Number(tenantId);
  if (tenantId === undefined || tenantId === null || !Number.isInteger(n) || n <= 0) {
    throw new TenantScopeError('scopedQuery requires a positive integer tenantId');
  }
  if (!/tenant_id/i.test(text)) {
    throw new TenantScopeError(
      'scopedQuery: SQL does not reference tenant_id — refusing an unscoped query',
    );
  }
  return query<T>(text, [tenantId, ...params]);
}
