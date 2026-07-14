import { scopedQuery } from '../../db/scoped.js';

/**
 * CHUNK_3_READ — the read-only audit trail. Tenant-scoped, newest first. This surface
 * only READS `audit_log`; rows are written centrally by the CHUNK_2 service layer.
 */

export interface AuditRow {
  id: number;
  actor: string;
  action: string;
  entity: string | null;
  realm: string | null;
  detail: unknown;
  at: string;
}

interface AuditDbRow {
  id: number;
  actor: string;
  action: string;
  entity: string | null;
  realm: string | null;
  detail: unknown;
  at: Date;
}

export async function listAudit(
  tenantId: number,
  opts: { action?: string; entity?: string; limit?: number } = {},
): Promise<AuditRow[]> {
  const params: unknown[] = [];
  let where = 'tenant_id = $1';
  if (opts.action) {
    params.push(opts.action);
    where += ` AND action = $${params.length + 1}`;
  }
  if (opts.entity) {
    params.push(opts.entity);
    where += ` AND entity = $${params.length + 1}`;
  }
  params.push(opts.limit ?? 200);
  const limitParam = `$${params.length + 1}`;
  const { rows } = await scopedQuery<AuditDbRow>(
    tenantId,
    `SELECT id, actor, action, entity, realm, detail, at
       FROM audit_log WHERE ${where} ORDER BY at DESC, id DESC LIMIT ${limitParam}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    actor: r.actor,
    action: r.action,
    entity: r.entity,
    realm: r.realm,
    detail: r.detail,
    at: r.at.toISOString(),
  }));
}
