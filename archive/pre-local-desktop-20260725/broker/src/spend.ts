import { query } from './db.js';

/**
 * Per-install spend tracking + weekly hard cap (CHUNK_3, SPEC §7/§8).
 *
 * The cap is checked BEFORE any paid upstream call. If week-to-date spend is at
 * or above the install's cap, the upstream call is NOT made (429). This is what
 * bounds the blast radius of a leaked install token to `weekly_cap_usd` — the
 * entire financial-safety argument for the broker over baking keys into the app.
 */

// Estimate-only pricing for claude-sonnet-4-5 (USD per token). Used to bound
// spend, NOT for billing. Conservative; refine if Anthropic pricing changes.
const ANTHROPIC_INPUT_USD_PER_TOKEN = 3 / 1_000_000;
const ANTHROPIC_OUTPUT_USD_PER_TOKEN = 15 / 1_000_000;
// Flat fallback when a response carries no usage, and flat cost per SwarmSync call.
const ANTHROPIC_FLAT_FALLBACK_USD = 0.03;
const SWARMSYNC_FLAT_USD = 0.01;

export type Upstream = 'anthropic' | 'swarmsync';

/** Week-to-date spend for an install (USD), from the start of the current ISO week. */
export async function weekToDateSpendUsd(installId: string): Promise<number> {
  const { rows } = await query<{ total: string }>(
    `SELECT COALESCE(SUM(est_usd), 0)::text AS total
       FROM spend_ledger
      WHERE install_id = $1
        AND occurred_at >= date_trunc('week', now())`,
    [installId],
  );
  return Number(rows[0]?.total ?? '0');
}

/**
 * True if the install is AT or OVER its weekly cap (→ caller returns 429 and does
 * NOT call upstream). Fails CLOSED: if the spend query throws, the caller's DB
 * error path already refuses the request (503), so we never call upstream blind.
 */
export async function isOverCap(installId: string, weeklyCapUsd: number): Promise<boolean> {
  const spent = await weekToDateSpendUsd(installId);
  return spent >= weeklyCapUsd;
}

export function estimateAnthropicUsd(usage?: { input_tokens?: number; output_tokens?: number }): number {
  if (!usage || (usage.input_tokens == null && usage.output_tokens == null)) {
    return ANTHROPIC_FLAT_FALLBACK_USD;
  }
  return (
    (usage.input_tokens ?? 0) * ANTHROPIC_INPUT_USD_PER_TOKEN +
    (usage.output_tokens ?? 0) * ANTHROPIC_OUTPUT_USD_PER_TOKEN
  );
}

export function swarmsyncFlatUsd(): number {
  return SWARMSYNC_FLAT_USD;
}

/** Seconds until the current spend window (ISO week) resets — for Retry-After. */
export async function secondsToWeekReset(): Promise<number> {
  const { rows } = await query<{ secs: string }>(
    `SELECT EXTRACT(EPOCH FROM (date_trunc('week', now()) + interval '1 week' - now()))::int::text AS secs`,
  );
  return Math.max(1, Number(rows[0]?.secs ?? '3600'));
}

/** Record spend AFTER a successful upstream call. */
export async function recordSpend(installId: string, upstream: Upstream, estUsd: number): Promise<void> {
  await query('INSERT INTO spend_ledger (install_id, upstream, est_usd) VALUES ($1, $2, $3)', [
    installId,
    upstream,
    estUsd.toFixed(4),
  ]);
}
