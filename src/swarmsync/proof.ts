import type { PoolClient } from 'pg';
import { query } from '../db/pool.js';

/**
 * proof_refs helpers (Amendment A1). The UNIQUE(tenant_id, entity_kind, entity_id,
 * product) constraint is the proof-submission idempotency guard: check-before-submit
 * and ON CONFLICT DO NOTHING mean job retries never double-submit a proof.
 */

export type EntityKind = 'attachment' | 'extraction' | 'proposal' | 'posting' | 'audit_day';
export type Product = 'verify_api' | 'invoiceproof' | 'auditproof';

export interface ProofRefInput {
  tenantId: number;
  entityKind: EntityKind;
  entityId: string;
  product: Product;
  proofId?: string | null;
  chainHash?: string | null;
  verdict?: string | null;
  findings?: unknown;
  response?: unknown;
}

export async function hasProofRef(
  tenantId: number,
  entityKind: EntityKind,
  entityId: string,
  product: Product,
): Promise<boolean> {
  const res = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM proof_refs
     WHERE tenant_id=$1 AND entity_kind=$2 AND entity_id=$3 AND product=$4`,
    [tenantId, entityKind, entityId, product],
  );
  return (res.rows[0]?.n ?? 0) > 0;
}

export async function recordProofRef(input: ProofRefInput, client?: PoolClient): Promise<void> {
  const sql = `INSERT INTO proof_refs
      (tenant_id, entity_kind, entity_id, product, proof_id, chain_hash, verdict, findings, response)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, entity_kind, entity_id, product) DO NOTHING`;
  const params = [
    input.tenantId,
    input.entityKind,
    input.entityId,
    input.product,
    input.proofId ?? null,
    input.chainHash ?? null,
    input.verdict ?? null,
    input.findings === undefined ? null : JSON.stringify(input.findings),
    input.response === undefined ? null : JSON.stringify(input.response),
  ];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}

export async function getProofRefs(
  tenantId: number,
  entityKind: EntityKind,
  entityId: string,
): Promise<Array<{ product: Product; proof_id: string | null; chain_hash: string | null }>> {
  const res = await query<{ product: Product; proof_id: string | null; chain_hash: string | null }>(
    `SELECT product, proof_id, chain_hash FROM proof_refs
     WHERE tenant_id=$1 AND entity_kind=$2 AND entity_id=$3`,
    [tenantId, entityKind, entityId],
  );
  return res.rows;
}
