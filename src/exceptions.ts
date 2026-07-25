import type { PoolClient } from 'pg';
import { query } from './db/pool.js';
import { maybeRaiseRiskAlert } from './services/digest.js';

/**
 * The complete typed exception taxonomy (brainstorm §12 + Amendment A1 + Phase 0.5).
 * No path swallows an error silently — every business failure becomes a row here.
 */
export const REASON_CODES = [
  'low_confidence',
  'unknown_vendor',
  'unmapped_account',
  'unmapped_dimension',
  'duplicate',
  'duplicate_in_qbo',
  'missing_invoice_no',
  'total_mismatch',
  'no_attachment',
  'bad_pdf',
  'unsupported_file',
  'bank_change_warning',
  'extraction_failed',
  'verify_mismatch',
  'attachment_failed',
  'qbo_api_error',
  'auth_failure',
  // Amendment A1
  'fraud_flag',
  'proof_scan_unavailable',
  // Phase 0.5 gatekeeper
  'unscannable_format',
  'forward_failed',
  'alert_failed',
  // CHUNK_6_ONBOARDING
  'dry_run_locked',
  // FIX-F5 live-posting hardening: fail-closed dedup + wrong-company guard
  'dedup_unavailable',
  'company_mismatch',
  // F5 accounting-behavior: dimension carry-through + named tax holds.
  // A dimension the provider cannot represent, or a mapped dimension that fails
  // read-back, is surfaced here (never silently dropped).
  'dimension_unsupported',
  'dimension_mismatch',
  // Tax is held BEFORE create with a NAMED reason (not the generic verify_mismatch)
  // whenever it cannot be safely represented: no configured code, or it does not
  // reconcile to the invoice total within currency tolerance.
  'tax_unmapped',
  'tax_unreconciled',
  // F_TAX_DIMENSION_MAPPING_GATE (posting-pipeline): a resolved tax code with NO
  // corresponding persisted tax_mappings row, or a row that is inactive/superseded, or
  // one flagged needs_revalidation, all hold BEFORE create — never guessed, never
  // posted on stale/absent config.
  'tax_mapping_not_found',
  'tax_mapping_inactive',
  'tax_mapping_needs_revalidation',
  // Same fail-closed principle for the persisted, human-reviewed dimension_mappings row:
  // no row, a resolution_state other than 'mapped', or a review_status that isn't
  // accepted/corrected all hold (intentionally_blank dimensions are exempt — see
  // src/mapping/dimensions.ts evaluateDimensionMappingRecord).
  'dimension_mapping_not_found',
  'dimension_mapping_not_mapped',
  'dimension_mapping_not_reviewed',
  // LLM backend router (src/llm/provider.ts): no local runtime, no OpenAI-compatible
  // endpoint, no key, and no explicitly-chosen CLI — resolved lazily per extract job
  // (LlmNotConfiguredError), so this must be a visible exceptions row, not a bare
  // job throw (fail-closed; see src/pipeline/extract.ts extractHandler).
  'extractor_not_configured',
  'statement_unreadable',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export interface RaiseExceptionInput {
  tenantId: number;
  reasonCode: ReasonCode;
  entityRef?: string;
  detail?: string;
}

export async function raiseException(
  input: RaiseExceptionInput,
  client?: PoolClient,
): Promise<number> {
  const sql = `INSERT INTO exceptions (tenant_id, reason_code, entity_ref, detail)
               VALUES ($1, $2, $3, $4) RETURNING id`;
  const params = [input.tenantId, input.reasonCode, input.entityRef ?? null, input.detail ?? null];
  const res = client ? await client.query(sql, params) : await query(sql, params);
  // CHUNK_7_DIGEST: material-risk reason codes (only ever raised from the severity
  // classifier's critical/high verdict — see swarmsync/severity.ts) also earn an
  // immediate risk_alert notification. Routine reason codes raise nothing.
  await maybeRaiseRiskAlert(input.tenantId, input.reasonCode, input.entityRef, input.detail, client);
  return res.rows[0].id as number;
}

export async function openExceptionsFor(
  tenantId: number,
  entityRef: string,
  reasonCode?: ReasonCode,
): Promise<number> {
  const sql = reasonCode
    ? `SELECT count(*)::int AS n FROM exceptions WHERE tenant_id=$1 AND entity_ref=$2 AND reason_code=$3 AND status='open'`
    : `SELECT count(*)::int AS n FROM exceptions WHERE tenant_id=$1 AND entity_ref=$2 AND status='open'`;
  const params = reasonCode ? [tenantId, entityRef, reasonCode] : [tenantId, entityRef];
  const res = await query<{ n: number }>(sql, params);
  return res.rows[0]?.n ?? 0;
}
