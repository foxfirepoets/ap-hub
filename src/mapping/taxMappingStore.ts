import type pg from 'pg';
import { scopedQuery } from '../db/scoped.js';

/**
 * F_TAX_MAPPING_API — pure DB access for `tax_mappings` / `tax_mapping_audit`
 * (migration 007). No auth/permission logic lives here (that's the service layer,
 * `src/services/taxMappings.ts`); every function is tenant-scoped via `scopedQuery`
 * (pool reads) or an explicit `tenant_id =` predicate (transactional writes), so a
 * caller can never read or mutate another tenant's rows even if it guesses an id.
 */

export type TaxMode = 'exclusive' | 'inclusive';
export type AppliesAt = 'invoice' | 'line';
export type AuditAction = 'create' | 'edit' | 'disable' | 'replace' | 'revalidate';

export interface TaxMappingRow {
  id: number;
  tenantId: number;
  connectionId: number;
  provider: string;
  providerTaxCode: string;
  internalTaxTreatment: string;
  taxMode: TaxMode;
  appliesAt: AppliesAt;
  active: boolean;
  needsRevalidation: boolean;
  supersededById: number | null;
  replacedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TaxMappingDbRow {
  id: number;
  tenant_id: number;
  connection_id: number;
  provider: string;
  provider_tax_code: string;
  internal_tax_treatment: string;
  tax_mode: TaxMode;
  applies_at: AppliesAt;
  active: boolean;
  needs_revalidation: boolean;
  superseded_by_id: number | null;
  replaced_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(r: TaxMappingDbRow): TaxMappingRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    connectionId: r.connection_id,
    provider: r.provider,
    providerTaxCode: r.provider_tax_code,
    internalTaxTreatment: r.internal_tax_treatment,
    taxMode: r.tax_mode,
    appliesAt: r.applies_at,
    active: r.active,
    needsRevalidation: r.needs_revalidation,
    supersededById: r.superseded_by_id,
    replacedAt: r.replaced_at ? r.replaced_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const SELECT_COLS =
  'id, tenant_id, connection_id, provider, provider_tax_code, internal_tax_treatment, ' +
  'tax_mode, applies_at, active, needs_revalidation, superseded_by_id, replaced_at, created_at, updated_at';

// --- pool-based reads (outside any transaction; used for GET/list and post-write read-back) ---

export async function getTaxMappingById(tenantId: number, id: number): Promise<TaxMappingRow | null> {
  const { rows } = await scopedQuery<TaxMappingDbRow>(
    tenantId,
    `SELECT ${SELECT_COLS} FROM tax_mappings WHERE tenant_id = $1 AND id = $2`,
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface ListTaxMappingsOpts {
  connectionId?: number;
  active?: boolean;
  needsRevalidation?: boolean;
  provider?: string;
  limit?: number;
}

export async function listTaxMappings(tenantId: number, opts: ListTaxMappingsOpts = {}): Promise<TaxMappingRow[]> {
  const params: unknown[] = [];
  let where = 'tenant_id = $1';
  if (opts.connectionId !== undefined) {
    params.push(opts.connectionId);
    where += ` AND connection_id = $${params.length + 1}`;
  }
  if (opts.active !== undefined) {
    params.push(opts.active);
    where += ` AND active = $${params.length + 1}`;
  }
  if (opts.needsRevalidation !== undefined) {
    params.push(opts.needsRevalidation);
    where += ` AND needs_revalidation = $${params.length + 1}`;
  }
  if (opts.provider) {
    params.push(opts.provider);
    where += ` AND provider = $${params.length + 1}`;
  }
  params.push(opts.limit ?? 500);
  const limitParam = `$${params.length + 1}`;
  const { rows } = await scopedQuery<TaxMappingDbRow>(
    tenantId,
    `SELECT ${SELECT_COLS} FROM tax_mappings WHERE ${where} ORDER BY created_at DESC LIMIT ${limitParam}`,
    params,
  );
  return rows.map(mapRow);
}

/** True if the connection belongs to (and is not disabled/revoked for) this tenant. */
export async function connectionBelongsToTenant(tenantId: number, connectionId: number): Promise<boolean> {
  const { rows } = await scopedQuery(
    tenantId,
    'SELECT id FROM connections WHERE tenant_id = $1 AND id = $2',
    [connectionId],
  );
  return rows.length > 0;
}

// --- transactional writes (called inside `withTransaction`) ---------------------------------

export interface InsertTaxMappingParams {
  tenantId: number;
  connectionId: number;
  provider: string;
  providerTaxCode: string;
  internalTaxTreatment: string;
  taxMode: TaxMode;
  appliesAt: AppliesAt;
  needsRevalidation: boolean;
}

export async function insertTaxMappingTx(client: pg.PoolClient, p: InsertTaxMappingParams): Promise<TaxMappingRow> {
  const { rows } = await client.query<TaxMappingDbRow>(
    `INSERT INTO tax_mappings
       (tenant_id, connection_id, provider, provider_tax_code, internal_tax_treatment, tax_mode, applies_at, needs_revalidation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING ${SELECT_COLS}`,
    [p.tenantId, p.connectionId, p.provider, p.providerTaxCode, p.internalTaxTreatment, p.taxMode, p.appliesAt, p.needsRevalidation],
  );
  return mapRow(rows[0]!);
}

export async function getTaxMappingByIdTx(client: pg.PoolClient, tenantId: number, id: number): Promise<TaxMappingRow | null> {
  const { rows } = await client.query<TaxMappingDbRow>(
    `SELECT ${SELECT_COLS} FROM tax_mappings WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function findActiveMappingTx(
  client: pg.PoolClient,
  tenantId: number,
  connectionId: number,
  provider: string,
  providerTaxCode: string,
): Promise<TaxMappingRow | null> {
  const { rows } = await client.query<TaxMappingDbRow>(
    `SELECT ${SELECT_COLS} FROM tax_mappings
     WHERE tenant_id = $1 AND connection_id = $2 AND provider = $3 AND provider_tax_code = $4 AND active`,
    [tenantId, connectionId, provider, providerTaxCode],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface EditTaxMappingParams {
  internalTaxTreatment: string;
  taxMode: TaxMode;
  appliesAt: AppliesAt;
}

export async function updateTaxMappingTx(
  client: pg.PoolClient,
  tenantId: number,
  id: number,
  p: EditTaxMappingParams,
): Promise<TaxMappingRow | null> {
  const { rows } = await client.query<TaxMappingDbRow>(
    `UPDATE tax_mappings
     SET internal_tax_treatment = $3, tax_mode = $4, applies_at = $5, needs_revalidation = true, updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${SELECT_COLS}`,
    [tenantId, id, p.internalTaxTreatment, p.taxMode, p.appliesAt],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function disableTaxMappingTx(client: pg.PoolClient, tenantId: number, id: number): Promise<TaxMappingRow | null> {
  const { rows } = await client.query<TaxMappingDbRow>(
    `UPDATE tax_mappings
     SET active = false, needs_revalidation = true, updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${SELECT_COLS}`,
    [tenantId, id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Mark `id` superseded by `newId`: active=false, replaced_at=now(), superseded_by_id=newId. */
export async function supersedeTaxMappingTx(
  client: pg.PoolClient,
  tenantId: number,
  id: number,
  newId: number,
): Promise<TaxMappingRow | null> {
  const { rows } = await client.query<TaxMappingDbRow>(
    `UPDATE tax_mappings
     SET active = false, replaced_at = now(), superseded_by_id = $3, needs_revalidation = true, updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${SELECT_COLS}`,
    [tenantId, id, newId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface SetRevalidationOutcomeParams {
  active: boolean;
  needsRevalidation: boolean;
}

export async function setRevalidationOutcomeTx(
  client: pg.PoolClient,
  tenantId: number,
  id: number,
  p: SetRevalidationOutcomeParams,
): Promise<TaxMappingRow | null> {
  const { rows } = await client.query<TaxMappingDbRow>(
    `UPDATE tax_mappings
     SET active = $3, needs_revalidation = $4, updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${SELECT_COLS}`,
    [tenantId, id, p.active, p.needsRevalidation],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

// --- audit trail (tax_mapping_audit; append-only) ------------------------------------------

export interface InsertAuditRowParams {
  tenantId: number;
  taxMappingId: number;
  connectionId: number;
  provider: string;
  changedBy: number | null;
  action: AuditAction;
  reason: string | null;
}

export async function insertAuditRowTx(client: pg.PoolClient, p: InsertAuditRowParams): Promise<void> {
  await client.query(
    `INSERT INTO tax_mapping_audit (tenant_id, tax_mapping_id, connection_id, provider, changed_by, action, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [p.tenantId, p.taxMappingId, p.connectionId, p.provider, p.changedBy, p.action, p.reason],
  );
}

export interface TaxMappingAuditRow {
  id: number;
  taxMappingId: number;
  connectionId: number;
  provider: string;
  changedBy: number | null;
  action: AuditAction;
  reason: string | null;
  changedAt: string;
}

interface TaxMappingAuditDbRow {
  id: number;
  tax_mapping_id: number;
  connection_id: number;
  provider: string;
  changed_by: number | null;
  action: AuditAction;
  reason: string | null;
  changed_at: Date;
}

export async function listAuditForMapping(tenantId: number, taxMappingId: number): Promise<TaxMappingAuditRow[]> {
  const { rows } = await scopedQuery<TaxMappingAuditDbRow>(
    tenantId,
    `SELECT id, tax_mapping_id, connection_id, provider, changed_by, action, reason, changed_at
     FROM tax_mapping_audit WHERE tenant_id = $1 AND tax_mapping_id = $2 ORDER BY changed_at ASC`,
    [taxMappingId],
  );
  return rows.map((r) => ({
    id: r.id,
    taxMappingId: r.tax_mapping_id,
    connectionId: r.connection_id,
    provider: r.provider,
    changedBy: r.changed_by,
    action: r.action,
    reason: r.reason,
    changedAt: r.changed_at.toISOString(),
  }));
}
