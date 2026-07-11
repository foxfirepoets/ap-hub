import type { PoolClient } from 'pg';
import { query } from './db/pool.js';
import { redact } from './logger.js';
import { sha256Hex } from './crypto.js';

/**
 * audit_log writer. Every state transition and external API call records one row.
 * `detail` is redacted before storage — no token/PII/bank field is ever persisted
 * in an audit line either.
 */
export interface AuditInput {
  tenantId?: number | null;
  actor?: string;
  action: string;
  entity?: string;
  beforeHash?: string;
  afterHash?: string;
  realm?: string;
  detail?: Record<string, unknown>;
}

export async function writeAudit(input: AuditInput, client?: PoolClient): Promise<void> {
  const sql = `INSERT INTO audit_log (tenant_id, actor, action, entity, before_hash, after_hash, realm, detail)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
  const params = [
    input.tenantId ?? null,
    input.actor ?? 'system',
    input.action,
    input.entity ?? null,
    input.beforeHash ?? null,
    input.afterHash ?? null,
    input.realm ?? null,
    input.detail ? JSON.stringify(redact(input.detail)) : null,
  ];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}

export function hashOf(value: unknown): string {
  return sha256Hex(JSON.stringify(value ?? null));
}
