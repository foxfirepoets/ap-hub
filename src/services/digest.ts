import type { PoolClient } from 'pg';
import type PgBoss from 'pg-boss';
import { query } from '../db/pool.js';
import { getTodayCounts, type TodayCounts } from './read/today.js';
import { logger } from '../logger.js';
import { JOBS } from '../queue.js';

/**
 * CHUNK_7_DIGEST — the notification layer. Two producers, one table:
 *
 *  1. `generateDailyDigest` — one `daily_digest` notification per tenant per day,
 *     with posted/held/failed/exception counts pulled from `getTodayCounts`
 *     (CHUNK_3), the SAME query the Today page uses — no separate risk list is
 *     ever computed here. If that source is unavailable, the batch DEFERS (no row
 *     written) rather than emitting zero/guessed counts; the next run retries.
 *
 *  2. `maybeRaiseRiskAlert` — called from `raiseException` (src/exceptions.ts) for
 *     every exception raised. Reuses `src/swarmsync/severity.ts` classification
 *     indirectly: the only reason codes that ever reach `raiseException` as
 *     `bank_change_warning` / `duplicate` / `fraud_flag` are the ones
 *     `classifyFindings` itself produced (see pipeline/mapping.ts,
 *     gatekeeper/gatekeep.ts) — so this never forks a second severity judgement.
 *     Routine reason codes (low_confidence, unmapped_account, ...) raise nothing.
 *
 * CHUNK_6_SWARMSYNC_POLICY (architecture-decision-packet §5) extends proof_fail_safe
 * with two more cases, both enforced right here:
 *  - Rule 2: `swarmsync_required_unavailable` (raised by src/pipeline/posting.ts and
 *    src/pipeline/gatekeep.ts when a company's policy requires SwarmSync verification
 *    but it is disabled/unavailable) is treated as material risk — it must be
 *    reported immediately, never silently buried until the next daily digest.
 *  - Rule 3: the digest emits only structured counts (see TodayCounts / DigestResult)
 *    — it has no natural-language "independently verified" labelling to get wrong.
 *    No verification-status UI exists yet in this codebase (confirmed empty grep for
 *    "independently verified" across app/ and src/). When such a UI is built, it must
 *    never render that phrase for an item without a stored proof reference for that
 *    specific item (src/swarmsync/proof.ts `hasProofRef`) — see test/digest.test.ts
 *    for a guard test enforcing this on every payload this module writes today.
 */

/** Reason codes that only ever originate from `classifyFindings`' critical/high path,
 *  plus `swarmsync_required_unavailable` (a company-mandated control that could not
 *  run — rule 2 above). */
const MATERIAL_RISK_REASONS = new Set([
  'bank_change_warning',
  'duplicate',
  'fraud_flag',
  'swarmsync_required_unavailable',
]);

const RISK_SEVERITY: Record<string, string> = {
  bank_change_warning: 'critical',
  duplicate: 'critical',
  fraud_flag: 'high',
  swarmsync_required_unavailable: 'high',
};

/** Insert an immediate `risk_alert` notification iff `reasonCode` is material risk. No-op otherwise. */
export async function maybeRaiseRiskAlert(
  tenantId: number,
  reasonCode: string,
  entityRef?: string | null,
  detail?: string | null,
  client?: PoolClient,
): Promise<void> {
  if (!MATERIAL_RISK_REASONS.has(reasonCode)) return;
  const sql = `INSERT INTO notifications (tenant_id, kind, severity, payload)
               VALUES ($1, 'risk_alert', $2, $3)`;
  const params = [
    tenantId,
    RISK_SEVERITY[reasonCode] ?? 'high',
    JSON.stringify({ reasonCode, entityRef: entityRef ?? null, detail: detail ?? null }),
  ];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}

export type DigestResult =
  | { status: 'created'; day: string; notificationId: number; counts: TodayCounts }
  | { status: 'exists'; day: string }
  | { status: 'deferred'; day: string; reason: string };

/**
 * Compute and write one tenant's daily digest for `day` (YYYY-MM-DD). Idempotent:
 * a second call for the same (tenant, day) is a no-op (`exists`), enforced both by
 * a pre-check and the `uq_notifications_daily_digest` partial unique index (so a
 * concurrent re-run can never double-write). `getCounts` is injectable so tests can
 * simulate the severity/exceptions source being unavailable.
 */
export async function generateDailyDigest(
  tenantId: number,
  day: string,
  getCounts: (tenantId: number) => Promise<TodayCounts> = getTodayCounts,
): Promise<DigestResult> {
  const existing = await query<{ id: number }>(
    `SELECT id FROM notifications WHERE tenant_id=$1 AND kind='daily_digest' AND digest_batch=$2`,
    [tenantId, day],
  );
  if (existing.rows[0]) return { status: 'exists', day };

  let counts: TodayCounts;
  try {
    counts = await getCounts(tenantId);
  } catch (err) {
    // Fail-safe (mirrors proof_fail_safe): never guess/zero-fill counts. Defer to next run.
    logger.warn({ err: String(err), tenantId, day }, 'digest deferred: counts source unavailable');
    return { status: 'deferred', day, reason: (err as Error).message };
  }

  const res = await query<{ id: number }>(
    `INSERT INTO notifications (tenant_id, kind, severity, payload, digest_batch)
     VALUES ($1, 'daily_digest', 'info', $2, $3)
     ON CONFLICT (tenant_id, digest_batch) WHERE kind='daily_digest' DO NOTHING
     RETURNING id`,
    [tenantId, JSON.stringify(counts), day],
  );
  const row = res.rows[0];
  if (!row) return { status: 'exists', day }; // lost the race to a concurrent run
  return { status: 'created', day, notificationId: row.id, counts };
}

export interface DigestJob {
  tenantId: number;
  day?: string; // YYYY-MM-DD (UTC); defaults to "today"
}

export async function digestHandler(job: { data: DigestJob }): Promise<DigestResult> {
  const day = job.data.day ?? new Date().toISOString().slice(0, 10);
  return generateDailyDigest(job.data.tenantId, day);
}

export async function scheduleDigest(boss: PgBoss): Promise<void> {
  const { rows } = await query<{ id: number }>('SELECT id FROM tenants WHERE paused=false');
  // Daily at 07:00 UTC per tenant (after the 03:00 audit anchor).
  for (const t of rows) {
    await boss.schedule(JOBS.digest, '0 7 * * *', { tenantId: t.id }, { tz: 'UTC' });
  }
}
