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
