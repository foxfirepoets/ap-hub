import type PgBoss from 'pg-boss';
import { query } from '../db/pool.js';
import { JOBS } from '../queue.js';
import { swarmsync } from '../services.js';
import { recordProofRef, hasProofRef } from '../swarmsync/proof.js';
import { raiseException } from '../exceptions.js';
import { sha256Hex } from '../crypto.js';
import { logger } from '../logger.js';

/**
 * CHUNK_8: daily AuditProof anchor. Computes the day's audit digest (row count +
 * SHA-256 over the ordered audit_log rows) and submits it with source_type
 * audit_proof, producing exactly one proof_refs row per (tenant, audit_day).
 * Failure → proof_scan_unavailable + retry next cycle; never blocks anything else.
 */

export interface AuditAnchorJob {
  tenantId: number;
  day?: string; // YYYY-MM-DD (UTC); defaults to "today"
}

import type { VerifyResult } from '../swarmsync/client.js';

/** Testable core: anchor one tenant-day's audit digest via the injected anchor fn. */
export async function anchorAuditDay(
  tenantId: number,
  day: string,
  anchor: (output: unknown) => Promise<VerifyResult>,
): Promise<{ anchored: boolean; day: string }> {
  if (await hasProofRef(tenantId, 'audit_day', day, 'auditproof')) {
    return { anchored: true, day };
  }

  const { rows } = await query<{ id: string; action: string; entity: string | null; at: string }>(
    `SELECT id::text, action, entity, at::text FROM audit_log
     WHERE tenant_id=$1 AND at::date = $2::date ORDER BY id ASC`,
    [tenantId, day],
  );
  const digest = sha256Hex(JSON.stringify(rows));

  try {
    const result = await anchor({ kind: 'audit_day', tenant_id: tenantId, day, row_count: rows.length, digest });
    await recordProofRef({
      tenantId,
      entityKind: 'audit_day',
      entityId: day,
      product: 'auditproof',
      proofId: result.proof_id,
      chainHash: result.chain_hash,
      verdict: result.verification_status,
      response: result.raw,
    });
    return { anchored: true, day };
  } catch (err) {
    logger.warn({ err: String(err), day }, 'audit anchor failed');
    await raiseException({
      tenantId,
      reasonCode: 'proof_scan_unavailable',
      entityRef: `audit_day:${day}`,
      detail: `AuditProof anchor failed: ${(err as Error).message}`,
    });
    return { anchored: false, day };
  }
}

export async function auditAnchorHandler(job: {
  data: AuditAnchorJob;
}): Promise<{ anchored: boolean; day: string }> {
  const { config } = await import('../config.js');
  const day = job.data.day ?? new Date().toISOString().slice(0, 10);
  // AuditProof anchoring is a SwarmSync feature; skip cleanly when disabled.
  if (!config().SWARMSYNC_ENABLED) return { anchored: false, day };
  return anchorAuditDay(job.data.tenantId, day, (output) => swarmsync().auditProof(output));
}

export async function scheduleAuditAnchor(boss: PgBoss): Promise<void> {
  const { rows } = await query<{ id: number }>('SELECT id FROM tenants WHERE paused=false');
  // Daily at 03:00 UTC per tenant.
  for (const t of rows) {
    await boss.schedule(JOBS.audit_anchor, '0 3 * * *', { tenantId: t.id }, { tz: 'UTC' });
  }
}
