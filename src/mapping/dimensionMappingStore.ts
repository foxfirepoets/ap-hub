import type pg from 'pg';
import { scopedQuery } from '../db/scoped.js';

/**
 * F_DIMENSION_MAPPING_API — pure DB access for `dimension_mappings` / `dimension_mapping_rules`
 * (migration 007). No auth/permission logic lives here (that's the service layer,
 * `src/services/dimensionMappings.ts`); every function is tenant-scoped via `scopedQuery`
 * (pool reads) or an explicit `tenant_id =` predicate (transactional writes), so a caller
 * can never read or mutate another tenant's rows even if it guesses an id — same pattern
 * as `taxMappingStore.ts`.
 *
 * Audit note: migration 007 provides no `dimension_mapping_audit` table (only
 * `tax_mapping_audit` exists, for tax_mappings). The service layer's `withAudit` generic
 * `audit_log` row (same mechanism every other mutation in this codebase uses) is therefore
 * the audit trail for dimension-mapping mutations — there is no second, domain-specific
 * table to write here.
 */

export { connectionBelongsToTenant } from './taxMappingStore.js';

export type DimensionType =
  | 'account' | 'item' | 'class' | 'location' | 'department' | 'customer'
  | 'project' | 'job' | 'tracking_category' | 'entity' | 'tax_code' | 'currency';
export type ReviewStatus = 'pending' | 'accepted' | 'corrected' | 'rejected' | 'held';
export type ResolutionState = 'mapped' | 'not_provided' | 'not_mapped' | 'unsupported_by_provider' | 'intentionally_blank';
export type MappingMethod = 'exact' | 'fuzzy' | 'learned_rule' | 'manual';

export interface DimensionMappingRow {
  id: number;
  tenantId: number;
  connectionId: number;
  provider: string;
  proposalId: number;
  dimensionType: DimensionType;
  rawValue: string;
  normalizedValue: string | null;
  sourceEvidence: Record<string, unknown>;
  extractionConfidence: number;
  proposedProviderId: string | null;
  proposedMatchLabel: string | null;
  providerId: string | null;
  mappingMethod: MappingMethod | null;
  reviewStatus: ReviewStatus;
  resolutionState: ResolutionState;
  active: boolean;
  mappingVersion: number;
  revalidatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DimensionMappingDbRow {
  id: number;
  tenant_id: number;
  connection_id: number;
  provider: string;
  proposal_id: number;
  dimension_type: DimensionType;
  raw_value: string;
  normalized_value: string | null;
  source_evidence: Record<string, unknown>;
  extraction_confidence: string;
  proposed_provider_id: string | null;
  proposed_match_label: string | null;
  provider_id: string | null;
  mapping_method: MappingMethod | null;
  review_status: ReviewStatus;
  resolution_state: ResolutionState;
  active: boolean;
  mapping_version: number;
  revalidated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(r: DimensionMappingDbRow): DimensionMappingRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    connectionId: r.connection_id,
    provider: r.provider,
    proposalId: r.proposal_id,
    dimensionType: r.dimension_type,
    rawValue: r.raw_value,
    normalizedValue: r.normalized_value,
    sourceEvidence: r.source_evidence,
    extractionConfidence: Number(r.extraction_confidence),
    proposedProviderId: r.proposed_provider_id,
    proposedMatchLabel: r.proposed_match_label,
    providerId: r.provider_id,
    mappingMethod: r.mapping_method,
    reviewStatus: r.review_status,
    resolutionState: r.resolution_state,
    active: r.active,
    mappingVersion: r.mapping_version,
    revalidatedAt: r.revalidated_at ? r.revalidated_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const SELECT_COLS =
  'id, tenant_id, connection_id, provider, proposal_id, dimension_type, raw_value, normalized_value, ' +
  'source_evidence, extraction_confidence, proposed_provider_id, proposed_match_label, provider_id, ' +
  'mapping_method, review_status, resolution_state, active, mapping_version, revalidated_at, created_at, updated_at';

// --- pool-based reads (outside any transaction; used for GET/list and post-write read-back) ---

export async function getDimensionMappingById(tenantId: number, id: number): Promise<DimensionMappingRow | null> {
  const { rows } = await scopedQuery<DimensionMappingDbRow>(
    tenantId,
    `SELECT ${SELECT_COLS} FROM dimension_mappings WHERE tenant_id = $1 AND id = $2`,
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface ListDimensionMappingsOpts {
  connectionId?: number;
  dimensionType?: DimensionType;
  reviewStatus?: ReviewStatus;
  resolutionState?: ResolutionState;
  provider?: string;
  limit?: number;
}

export async function listDimensionMappings(
  tenantId: number,
  opts: ListDimensionMappingsOpts = {},
): Promise<DimensionMappingRow[]> {
  const params: unknown[] = [];
  let where = 'tenant_id = $1';
  if (opts.connectionId !== undefined) {
    params.push(opts.connectionId);
    where += ` AND connection_id = $${params.length + 1}`;
  }
  if (opts.dimensionType !== undefined) {
    params.push(opts.dimensionType);
    where += ` AND dimension_type = $${params.length + 1}`;
  }
  if (opts.reviewStatus !== undefined) {
    params.push(opts.reviewStatus);
    where += ` AND review_status = $${params.length + 1}`;
  }
  if (opts.resolutionState !== undefined) {
    params.push(opts.resolutionState);
    where += ` AND resolution_state = $${params.length + 1}`;
  }
  if (opts.provider) {
    params.push(opts.provider);
    where += ` AND provider = $${params.length + 1}`;
  }
  params.push(opts.limit ?? 500);
  const limitParam = `$${params.length + 1}`;
  const { rows } = await scopedQuery<DimensionMappingDbRow>(
    tenantId,
    `SELECT ${SELECT_COLS} FROM dimension_mappings WHERE ${where} ORDER BY created_at DESC LIMIT ${limitParam}`,
    params,
  );
  return rows.map(mapRow);
}

// --- transactional writes (called inside `withTransaction`) ---------------------------------

export async function getDimensionMappingByIdTx(
  client: pg.PoolClient,
  tenantId: number,
  id: number,
): Promise<DimensionMappingRow | null> {
  const { rows } = await client.query<DimensionMappingDbRow>(
    `SELECT ${SELECT_COLS} FROM dimension_mappings WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface ResolveDimensionMappingParams {
  providerId: string;
  mappingMethod: MappingMethod;
}

/** Attach a confirmed provider_id (accept OR select-alternate): review_status -> accepted, resolution_state -> mapped. */
export async function resolveDimensionMappingTx(
  client: pg.PoolClient,
  tenantId: number,
  id: number,
  p: ResolveDimensionMappingParams,
): Promise<DimensionMappingRow | null> {
  const { rows } = await client.query<DimensionMappingDbRow>(
    `UPDATE dimension_mappings
     SET provider_id = $3, mapping_method = $4, review_status = 'accepted', resolution_state = 'mapped', updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${SELECT_COLS}`,
    [tenantId, id, p.providerId, p.mappingMethod],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function updateCorrectTx(
  client: pg.PoolClient,
  tenantId: number,
  id: number,
  normalizedValue: string,
): Promise<DimensionMappingRow | null> {
  const { rows } = await client.query<DimensionMappingDbRow>(
    `UPDATE dimension_mappings
     SET normalized_value = $3, review_status = 'corrected', updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${SELECT_COLS}`,
    [tenantId, id, normalizedValue],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function updateReviewStatusTx(
  client: pg.PoolClient,
  tenantId: number,
  id: number,
  status: 'rejected' | 'held',
): Promise<DimensionMappingRow | null> {
  const { rows } = await client.query<DimensionMappingDbRow>(
    `UPDATE dimension_mappings
     SET review_status = $3, updated_at = now()
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${SELECT_COLS}`,
    [tenantId, id, status],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface InsertDimensionMappingParams {
  tenantId: number;
  connectionId: number;
  provider: string;
  proposalId: number;
  dimensionType: DimensionType;
  rawValue: string;
  normalizedValue?: string | null;
  sourceEvidence?: Record<string, unknown>;
  extractionConfidence?: number;
  proposedProviderId?: string | null;
  proposedMatchLabel?: string | null;
  providerId?: string | null;
  mappingMethod?: MappingMethod | null;
  reviewStatus: ReviewStatus;
  resolutionState: ResolutionState;
}

/**
 * Persist one extraction-time dimension_mappings row (pool-based; called from the
 * map/propose pipeline stage, outside any transaction — mirrors the read helpers above).
 * Never upserts: the caller (proposeOnce) checks findDimensionMappingByProposalAndType
 * first so a re-run never clobbers an already-human-reviewed row.
 */
export async function insertDimensionMapping(p: InsertDimensionMappingParams): Promise<DimensionMappingRow> {
  const { rows } = await scopedQuery<DimensionMappingDbRow>(
    p.tenantId,
    `INSERT INTO dimension_mappings
       (tenant_id, connection_id, provider, proposal_id, dimension_type, raw_value, normalized_value,
        source_evidence, extraction_confidence, proposed_provider_id, proposed_match_label, provider_id,
        mapping_method, review_status, resolution_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING ${SELECT_COLS}`,
    [
      p.connectionId, p.provider, p.proposalId, p.dimensionType, p.rawValue,
      p.normalizedValue ?? null, JSON.stringify(p.sourceEvidence ?? {}), p.extractionConfidence ?? 0,
      p.proposedProviderId ?? null, p.proposedMatchLabel ?? null, p.providerId ?? null,
      p.mappingMethod ?? null, p.reviewStatus, p.resolutionState,
    ],
  );
  return mapRow(rows[0]!);
}

/** Existing row (if any) for this proposal+dimension_type — the idempotency check above. */
export async function findDimensionMappingByProposalAndType(
  tenantId: number,
  proposalId: number,
  dimensionType: DimensionType,
): Promise<DimensionMappingRow | null> {
  const { rows } = await scopedQuery<DimensionMappingDbRow>(
    tenantId,
    `SELECT ${SELECT_COLS} FROM dimension_mappings WHERE tenant_id = $1 AND proposal_id = $2 AND dimension_type = $3`,
    [proposalId, dimensionType],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export interface ActiveConnectionRef {
  id: number;
  provider: string;
}

/** The tenant's active accounting connection (Phase 1A: one live provider per tenant). */
export async function findActiveConnectionForTenant(tenantId: number): Promise<ActiveConnectionRef | null> {
  const { rows } = await scopedQuery<ActiveConnectionRef>(
    tenantId,
    `SELECT id, provider FROM connections WHERE tenant_id = $1 AND status = 'active' ORDER BY id ASC LIMIT 1`,
  );
  return rows[0] ?? null;
}

// --- dimension_mapping_rules ------------------------------------------------------------------

export interface DimensionMappingRuleRow {
  id: number;
  tenantId: number;
  connectionId: number;
  provider: string;
  dimensionType: DimensionType;
  normalizedValue: string;
  rawValue: string;
  providerId: string;
  providerLabel: string | null;
  mappingMethod: MappingMethod;
  active: boolean;
  mappingVersion: number;
  createdFromId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface DimensionMappingRuleDbRow {
  id: number;
  tenant_id: number;
  connection_id: number;
  provider: string;
  dimension_type: DimensionType;
  normalized_value: string;
  raw_value: string;
  provider_id: string;
  provider_label: string | null;
  mapping_method: MappingMethod;
  active: boolean;
  mapping_version: number;
  created_from_id: number | null;
  created_at: Date;
  updated_at: Date;
}

function mapRuleRow(r: DimensionMappingRuleDbRow): DimensionMappingRuleRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    connectionId: r.connection_id,
    provider: r.provider,
    dimensionType: r.dimension_type,
    normalizedValue: r.normalized_value,
    rawValue: r.raw_value,
    providerId: r.provider_id,
    providerLabel: r.provider_label,
    mappingMethod: r.mapping_method,
    active: r.active,
    mappingVersion: r.mapping_version,
    createdFromId: r.created_from_id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const RULE_SELECT_COLS =
  'id, tenant_id, connection_id, provider, dimension_type, normalized_value, raw_value, provider_id, ' +
  'provider_label, mapping_method, active, mapping_version, created_from_id, created_at, updated_at';

export async function getDimensionMappingRuleById(tenantId: number, id: number): Promise<DimensionMappingRuleRow | null> {
  const { rows } = await scopedQuery<DimensionMappingRuleDbRow>(
    tenantId,
    `SELECT ${RULE_SELECT_COLS} FROM dimension_mapping_rules WHERE tenant_id = $1 AND id = $2`,
    [id],
  );
  return rows[0] ? mapRuleRow(rows[0]) : null;
}

/** Find the active rule (if any) for this exact company+provider+dimension_type+normalized_value key. */
export async function findActiveRuleTx(
  client: pg.PoolClient,
  tenantId: number,
  connectionId: number,
  provider: string,
  dimensionType: DimensionType,
  normalizedValue: string,
): Promise<DimensionMappingRuleRow | null> {
  const { rows } = await client.query<DimensionMappingRuleDbRow>(
    `SELECT ${RULE_SELECT_COLS} FROM dimension_mapping_rules
     WHERE tenant_id = $1 AND connection_id = $2 AND provider = $3 AND dimension_type = $4 AND normalized_value = $5 AND active`,
    [tenantId, connectionId, provider, dimensionType, normalizedValue],
  );
  return rows[0] ? mapRuleRow(rows[0]) : null;
}

export interface InsertDimensionMappingRuleParams {
  tenantId: number;
  connectionId: number;
  provider: string;
  dimensionType: DimensionType;
  normalizedValue: string;
  rawValue: string;
  providerId: string;
  providerLabel: string | null;
  mappingMethod: MappingMethod;
  createdFromId: number;
}

export async function insertDimensionMappingRuleTx(
  client: pg.PoolClient,
  p: InsertDimensionMappingRuleParams,
): Promise<DimensionMappingRuleRow> {
  const { rows } = await client.query<DimensionMappingRuleDbRow>(
    `INSERT INTO dimension_mapping_rules
       (tenant_id, connection_id, provider, dimension_type, normalized_value, raw_value, provider_id,
        provider_label, mapping_method, created_from_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING ${RULE_SELECT_COLS}`,
    [
      p.tenantId, p.connectionId, p.provider, p.dimensionType, p.normalizedValue, p.rawValue,
      p.providerId, p.providerLabel, p.mappingMethod, p.createdFromId,
    ],
  );
  return mapRuleRow(rows[0]!);
}
