import { scopedQuery } from '../../db/scoped.js';

/**
 * CHUNK_3_READ — the exception queue. Read-only, tenant-scoped. `getExceptionById`
 * returns `null` when the id is not in the caller's tenant, so a cross-tenant lookup
 * yields 404 (never another tenant's row).
 */

export interface ExceptionRow {
  id: number;
  entityRef: string | null;
  reasonCode: string;
  detail: string | null;
  status: string;
  resolvedBy: string | null;
  resolution: unknown;
  createdAt: string;
  resolvedAt: string | null;
}

interface ExceptionDbRow {
  id: number;
  entity_ref: string | null;
  reason_code: string;
  detail: string | null;
  status: string;
  resolved_by: string | null;
  resolution: unknown;
  created_at: Date;
  resolved_at: Date | null;
}

function mapRow(r: ExceptionDbRow): ExceptionRow {
  return {
    id: r.id,
    entityRef: r.entity_ref,
    reasonCode: r.reason_code,
    detail: r.detail,
    status: r.status,
    resolvedBy: r.resolved_by,
    resolution: r.resolution,
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
  };
}

const SELECT_COLS =
  'id, entity_ref, reason_code, detail, status, resolved_by, resolution, created_at, resolved_at';

export async function listExceptions(
  tenantId: number,
  opts: { status?: string; limit?: number } = {},
): Promise<ExceptionRow[]> {
  const params: unknown[] = [];
  let where = 'tenant_id = $1';
  if (opts.status) {
    params.push(opts.status);
    where += ` AND status = $${params.length + 1}`;
  }
  params.push(opts.limit ?? 200);
  const limitParam = `$${params.length + 1}`;
  const { rows } = await scopedQuery<ExceptionDbRow>(
    tenantId,
    `SELECT ${SELECT_COLS} FROM exceptions WHERE ${where} ORDER BY created_at DESC LIMIT ${limitParam}`,
    params,
  );
  return rows.map(mapRow);
}

export async function getExceptionById(tenantId: number, id: number): Promise<ExceptionRow | null> {
  const { rows } = await scopedQuery<ExceptionDbRow>(
    tenantId,
    `SELECT ${SELECT_COLS} FROM exceptions WHERE tenant_id = $1 AND id = $2`,
    [id],
  );
  const r = rows[0];
  return r ? mapRow(r) : null;
}
