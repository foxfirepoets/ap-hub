/**
 * pilot-report computation (CHUNK_6). Turns liveness heartbeats into the three
 * numbers the pilot exists to produce:
 *
 *   1. online-hours %      — fraction of expected hours with an `alive` heartbeat
 *   2. watchdog recovery   — % of watchdog_restart events followed by an `alive`
 *   3. pg corruption count — # of pg_health events reporting pg_ok=false
 *
 * Pure function (no DB, no clock) so it is deterministic and unit-testable; the CLI
 * supplies rows + `now`. Online-hours are bucketed from `observed_at` (the broker's
 * server clock), never client-reported time.
 */

export interface HeartbeatRow {
  observed_at: Date;
  event: 'alive' | 'watchdog_restart' | 'pg_health' | 'shutdown';
  pg_ok: boolean | null;
  tz_offset_minutes: number | null;
}

export interface PilotReportOptions {
  days: number;
  businessHours: boolean;
  now: Date;
}

export interface PilotReport {
  dateRange: { from: string; to: string };
  days: number;
  businessHours: boolean;
  sampleSize: number;
  onlineHours: { onlineHourCount: number; expectedHours: number; pct: number | null };
  watchdogRecovery: { restarts: number; recovered: number; pct: number | null };
  pgHealth: { checks: number; corruptionCount: number };
}

const HOUR_MS = 3_600_000;
const RECOVERY_WINDOW_MS = 5 * 60_000; // an `alive` within 5 min of a restart = recovered

/** Hour-of-week (0=Mon 00:00 .. 167) for a UTC instant shifted by a tz offset. */
function localHourIndex(utcMs: number, tzOffsetMinutes: number): { dow: number; hour: number } {
  const local = new Date(utcMs + tzOffsetMinutes * 60_000);
  // getUTC* on the shifted instant yields the wall-clock in the local tz.
  const dow = (local.getUTCDay() + 6) % 7; // 0=Mon .. 6=Sun
  return { dow, hour: local.getUTCHours() };
}

function isBusinessHour(utcMs: number, tzOffsetMinutes: number): boolean {
  const { dow, hour } = localHourIndex(utcMs, tzOffsetMinutes);
  return dow <= 4 && hour >= 8 && hour < 18; // Mon–Fri 08:00–18:00
}

/** Most common tz offset among rows (used to size the business-hours denominator). */
function dominantTzOffset(rows: HeartbeatRow[]): number {
  const counts = new Map<number, number>();
  for (const r of rows) {
    if (r.tz_offset_minutes == null) continue;
    counts.set(r.tz_offset_minutes, (counts.get(r.tz_offset_minutes) ?? 0) + 1);
  }
  let best = 0;
  let bestN = -1;
  for (const [tz, n] of counts) if (n > bestN) ((best = tz), (bestN = n));
  return best;
}

export function computePilotReport(rows: HeartbeatRow[], opts: PilotReportOptions): PilotReport {
  const toMs = opts.now.getTime();
  const fromMs = toMs - opts.days * 24 * HOUR_MS;
  const inWindow = rows.filter((r) => r.observed_at.getTime() >= fromMs && r.observed_at.getTime() <= toMs);
  const tzOffset = dominantTzOffset(inWindow);

  // --- online hours: distinct hour buckets containing an `alive` heartbeat ---
  const onlineBuckets = new Set<number>();
  for (const r of inWindow) {
    if (r.event !== 'alive') continue;
    const bucket = Math.floor(r.observed_at.getTime() / HOUR_MS);
    if (opts.businessHours && !isBusinessHour(bucket * HOUR_MS, tzOffset)) continue;
    onlineBuckets.add(bucket);
  }

  // --- expected hours across the window (all hours, or business hours only) ---
  let expectedHours = 0;
  const firstBucket = Math.floor(fromMs / HOUR_MS);
  const lastBucket = Math.floor(toMs / HOUR_MS);
  if (opts.businessHours) {
    for (let b = firstBucket; b < lastBucket; b++) {
      if (isBusinessHour(b * HOUR_MS, tzOffset)) expectedHours++;
    }
  } else {
    expectedHours = opts.days * 24;
  }
  const onlinePct = expectedHours > 0 ? Math.min(100, (onlineBuckets.size / expectedHours) * 100) : null;

  // --- watchdog recovery: a restart followed by an `alive` within the window ---
  const alives = inWindow.filter((r) => r.event === 'alive').map((r) => r.observed_at.getTime()).sort((a, b) => a - b);
  const restarts = inWindow.filter((r) => r.event === 'watchdog_restart');
  let recovered = 0;
  for (const rs of restarts) {
    const t = rs.observed_at.getTime();
    if (alives.some((a) => a > t && a <= t + RECOVERY_WINDOW_MS)) recovered++;
  }
  const recoveryPct = restarts.length ? (recovered / restarts.length) * 100 : null;

  // --- pg health: corruption = a pg_health event reporting pg_ok=false ---
  const pgChecks = inWindow.filter((r) => r.event === 'pg_health');
  const corruptionCount = pgChecks.filter((r) => r.pg_ok === false).length;

  return {
    dateRange: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    days: opts.days,
    businessHours: opts.businessHours,
    sampleSize: inWindow.length,
    onlineHours: { onlineHourCount: onlineBuckets.size, expectedHours, pct: onlinePct },
    watchdogRecovery: { restarts: restarts.length, recovered, pct: recoveryPct },
    pgHealth: { checks: pgChecks.length, corruptionCount },
  };
}

/** Format a report as the operator-facing text block printed by `pilot-report`. */
export function formatPilotReport(r: PilotReport): string {
  const pct = (x: number | null) => (x == null ? 'n/a' : `${x.toFixed(1)}%`);
  return [
    `Pilot report — last ${r.days} day(s)${r.businessHours ? ' (business hours Mon–Fri 08:00–18:00)' : ''}`,
    `  date range:        ${r.dateRange.from}  ->  ${r.dateRange.to}`,
    `  sample size:       ${r.sampleSize} heartbeat(s)`,
    `  online-hours:      ${pct(r.onlineHours.pct)}  (${r.onlineHours.onlineHourCount}/${r.onlineHours.expectedHours} hrs)`,
    `  watchdog recovery: ${pct(r.watchdogRecovery.pct)}  (${r.watchdogRecovery.recovered}/${r.watchdogRecovery.restarts} restarts)`,
    `  pg corruption:     ${r.pgHealth.corruptionCount}  (of ${r.pgHealth.checks} pg_health check(s))`,
  ].join('\n');
}
