import { describe, it, expect } from 'vitest';
import { computePilotReport, formatPilotReport, type HeartbeatRow } from '../src/report.js';

/** CHUNK_6 pilot-report: the three numbers, computed deterministically from rows. */

const NOW = new Date('2026-07-18T12:00:00.000Z'); // a Saturday
function hb(iso: string, event: HeartbeatRow['event'], pg_ok: boolean | null = null, tz = 0): HeartbeatRow {
  return { observed_at: new Date(iso), event, pg_ok, tz_offset_minutes: tz };
}

describe('computePilotReport', () => {
  it('counts a watchdog_restart in the recovery numerator when an alive follows it', () => {
    const rows = [
      hb('2026-07-18T10:00:00Z', 'watchdog_restart'),
      hb('2026-07-18T10:01:00Z', 'alive'), // recovery within 5 min
      hb('2026-07-18T11:00:00Z', 'watchdog_restart'), // never recovered
    ];
    const r = computePilotReport(rows, { days: 7, businessHours: false, now: NOW });
    expect(r.watchdogRecovery.restarts).toBe(2);
    expect(r.watchdogRecovery.recovered).toBe(1);
    expect(r.watchdogRecovery.pct).toBeCloseTo(50);
  });

  it('online-hours counts distinct hour buckets with an alive heartbeat', () => {
    const rows = [
      hb('2026-07-18T09:05:00Z', 'alive'),
      hb('2026-07-18T09:35:00Z', 'alive'), // same hour bucket → still 1
      hb('2026-07-18T10:05:00Z', 'alive'), // second bucket
    ];
    const r = computePilotReport(rows, { days: 7, businessHours: false, now: NOW });
    expect(r.onlineHours.onlineHourCount).toBe(2);
    expect(r.onlineHours.expectedHours).toBe(7 * 24);
    expect(r.onlineHours.pct).toBeCloseTo((2 / 168) * 100);
  });

  it('pg corruption counts pg_health events reporting pg_ok=false', () => {
    const rows = [
      hb('2026-07-18T10:00:00Z', 'pg_health', true),
      hb('2026-07-18T11:00:00Z', 'pg_health', false),
      hb('2026-07-18T11:30:00Z', 'pg_health', false),
    ];
    const r = computePilotReport(rows, { days: 7, businessHours: false, now: NOW });
    expect(r.pgHealth.checks).toBe(3);
    expect(r.pgHealth.corruptionCount).toBe(2);
  });

  it('business-hours mode restricts online buckets and the denominator to Mon–Fri 08–18', () => {
    const rows = [
      hb('2026-07-13T09:00:00Z', 'alive'), // Monday 09:00 UTC — business hour
      hb('2026-07-18T09:00:00Z', 'alive'), // Saturday — excluded
    ];
    const r = computePilotReport(rows, { days: 7, businessHours: true, now: NOW });
    expect(r.onlineHours.onlineHourCount).toBe(1); // only the Monday bucket
    // 7-day window ending Sat noon spans 5 business days worth of 10h each (approx); just assert it's bounded.
    expect(r.onlineHours.expectedHours).toBeGreaterThan(0);
    expect(r.onlineHours.expectedHours).toBeLessThanOrEqual(5 * 10);
  });

  it('excludes rows outside the window and reports sample size + date range', () => {
    const rows = [
      hb('2026-07-18T10:00:00Z', 'alive'),
      hb('2026-06-01T10:00:00Z', 'alive'), // outside 7-day window
    ];
    const r = computePilotReport(rows, { days: 7, businessHours: false, now: NOW });
    expect(r.sampleSize).toBe(1);
    expect(r.dateRange.to).toBe(NOW.toISOString());
    expect(formatPilotReport(r)).toContain('online-hours');
  });

  it('no restarts → recovery pct is null (n/a), not a divide-by-zero', () => {
    const r = computePilotReport([hb('2026-07-18T10:00:00Z', 'alive')], { days: 7, businessHours: false, now: NOW });
    expect(r.watchdogRecovery.pct).toBeNull();
    expect(formatPilotReport(r)).toContain('n/a');
  });
});
