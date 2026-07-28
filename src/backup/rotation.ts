import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type PgBoss from 'pg-boss';
import { query as poolQuery } from '../db/pool.js';
import { createHostAdapter } from '../host/index.js';
import { JOBS } from '../queue.js';
import { childLogger } from '../logger.js';
import { alertBackupFailure } from './alerts.js';
import { createBackup, type BackupKind } from './create.js';
import { withBackupLock } from './lock.js';

const log = childLogger({ module: 'backup-rotation' });

/**
 * CHUNK_7_BACKUP rotation/retention policy.
 *
 * Retention: 7 most-recent daily backups, 4 weekly, 3 monthly, plus EVERY `pre_update`
 * backup regardless of age, plus the single newest verified backup overall (defense in
 * depth — kept even if the bucketing math above would otherwise let it go, per the
 * guardrail's own words: "never prunes down to zero verified copies").
 *
 * Only `verified_at IS NOT NULL` rows are ever candidates for keep OR prune (see
 * migrations/015_backups.sql: an unverified row "never counted as a usable backup").
 * Unverified rows' files are intentionally left untouched by this module — see the
 * doc comment on `selectBackupsToPrune` for why.
 */

/** Mirrors `SELECT * FROM backups` — snake_case to match the column names directly. */
export interface BackupRow {
  id: number;
  kind: BackupKind;
  path: string;
  size_bytes: number | string;
  manifest_hash: string;
  row_counts: Record<string, number>;
  verified_at: Date | string | null;
  external_copy: string | null;
  created_at: Date | string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_KEEP = 7;
const WEEKLY_KEEP = 4;
const MONTHLY_KEEP = 3;

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

/** Whole days between `createdAt` and `now`, clamped to 0 (never negative for clock-skew rows). */
function daysAgo(now: Date, createdAt: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS));
}

function keepNewest(bucket: Map<number, BackupRow>, idx: number, row: BackupRow): void {
  const existing = bucket.get(idx);
  if (!existing || toDate(row.created_at) > toDate(existing.created_at)) bucket.set(idx, row);
}

/**
 * Pure decision function: given every `backups` row, return exactly the rows that are
 * safe to prune (delete file + row) right now.
 *
 * Bucketing algorithm (relative to `now`, not calendar-aligned — deterministic and simple
 * to test across month boundaries):
 *   - Daily:   age 0-6 days   → one bucket per exact day-age;            keeps up to 7.
 *   - Weekly:  age 7-34 days  → bucket = floor((age-7)/7), 4 buckets;    keeps up to 4.
 *   - Monthly: age 35-124 days→ bucket = floor((age-35)/30), 3 buckets;  keeps up to 3.
 *   - age > 124 days and not otherwise kept → eligible for pruning.
 * Within every bucket only the newest backup is kept; older backups sharing a bucket
 * (or falling outside all buckets) are candidates for pruning.
 *
 * Overrides applied on top of bucketing:
 *   - `kind === 'pre_update'` rows are kept unconditionally, regardless of age or bucket.
 *   - The single newest verified backup (by `created_at`, across all kinds) is always
 *     kept, even if bucketing alone would not have kept it — the "never prune to zero
 *     verified copies" invariant, enforced here rather than only downstream.
 *
 * Unverified rows (`verified_at IS NULL`) are excluded from the input set entirely —
 * they are never returned as prune candidates, and never counted toward any bucket's
 * "kept" slot either. Decision documented in the CHUNK_7_BACKUP rotation report: an
 * unverified row already failed create.ts's own verification step (its failure is
 * loud — logged and, per acceptance criteria, surfaced to the user); this module
 * does not also decide to delete its file. That cleanup is left for a human or a
 * future chunk, so a still-diagnosable failed attempt is never silently erased by a
 * background job.
 */
export function selectBackupsToPrune(backups: BackupRow[], now: Date = new Date()): BackupRow[] {
  const verified = backups.filter((b) => b.verified_at != null);
  if (verified.length === 0) return [];

  const newest = verified.reduce((a, b) => (toDate(b.created_at) > toDate(a.created_at) ? b : a));

  const keepIds = new Set<number>([newest.id]);
  for (const b of verified) {
    if (b.kind === 'pre_update') keepIds.add(b.id);
  }

  const daily = new Map<number, BackupRow>();
  const weekly = new Map<number, BackupRow>();
  const monthly = new Map<number, BackupRow>();

  for (const b of verified) {
    if (b.kind === 'pre_update') continue; // already kept unconditionally; bucketing is moot
    const age = daysAgo(now, toDate(b.created_at));
    if (age < DAILY_KEEP) {
      keepNewest(daily, age, b);
    } else if (age < DAILY_KEEP + WEEKLY_KEEP * 7) {
      keepNewest(weekly, Math.floor((age - DAILY_KEEP) / 7), b);
    } else if (age < DAILY_KEEP + WEEKLY_KEEP * 7 + MONTHLY_KEEP * 30) {
      keepNewest(monthly, Math.floor((age - DAILY_KEEP - WEEKLY_KEEP * 7) / 30), b);
    }
    // else: outside every bucket window — not kept by rotation (may still be pruned).
  }

  for (const b of daily.values()) keepIds.add(b.id);
  for (const b of weekly.values()) keepIds.add(b.id);
  for (const b of monthly.values()) keepIds.add(b.id);

  return verified.filter((b) => !keepIds.has(b.id));
}

export interface PruneDeps {
  query: typeof poolQuery;
  unlink: (path: string) => Promise<void>;
  now?: () => Date;
}

export interface PruneResult {
  prunedIds: number[];
  skipped: Array<{ id: number; reason: string }>;
}

/**
 * Executes the prune decided by `selectBackupsToPrune`, but never trusts a
 * previously-computed list: for EACH candidate it re-queries `backups` fresh and
 * re-runs the selection function immediately before deleting that row, so a prune
 * that runs slowly (many files) or long after being computed can never delete past
 * the safety invariant — including the case where an intervening deletion (e.g. a
 * concurrent manual restore-cleanup) already changed which row is "newest verified".
 */
export async function pruneBackups(deps: Partial<PruneDeps> = {}): Promise<PruneResult> {
  const q = deps.query ?? poolQuery;
  const unlinkFile = deps.unlink ?? ((p: string) => unlink(p));
  const now = deps.now ?? (() => new Date());

  const initial = await q<BackupRow>('SELECT * FROM backups');
  const candidates = selectBackupsToPrune(initial.rows, now());

  const prunedIds: number[] = [];
  const skipped: Array<{ id: number; reason: string }> = [];

  for (const candidate of candidates) {
    const fresh = await q<BackupRow>('SELECT * FROM backups');
    const stillSafe = selectBackupsToPrune(fresh.rows, now()).some((r) => r.id === candidate.id);
    if (!stillSafe) {
      skipped.push({ id: candidate.id, reason: 'no longer safe to prune on re-check' });
      continue;
    }
    try {
      await unlinkFile(candidate.path);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err; // missing file is fine; still remove the row
    }
    await q('DELETE FROM backups WHERE id = $1', [candidate.id]);
    prunedIds.push(candidate.id);
  }

  return { prunedIds, skipped };
}

/**
 * Nightly job: create a fresh `scheduled` backup, then prune per retention policy.
 *
 * Path resolution: `desktop/database.ts` sets `APHUB_PG_BIN_DIR` / `APHUB_BACKUP_DIR` after
 * the bundled Postgres ACL is applied; `desktop/main.ts` registers this handler via
 * `registerPipelineJobs` once the private DB is up. When those env vars are absent (CLI /
 * `npm run dev` without the desktop path), fall back to `vendor/pgsql/bin` under cwd and
 * `host.dataDir()/backups` — the same layout the integration suite uses.
 */
export async function backupNightlyHandler(): Promise<void> {
  const host = createHostAdapter();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log.error('backup_nightly skipped — DATABASE_URL is not set');
    alertBackupFailure('AP-Hub could not run the nightly backup — the private database was not ready.');
    return;
  }
  const url = new URL(databaseUrl);
  const backupDir = join(host.dataDir(), 'backups');

  // The whole create-then-prune cycle runs under one lock acquisition, alongside every other
  // backup/restore/repair entry point (`src/backup/lock.ts`) — a manual restore or repair
  // landing mid-cycle would otherwise race the live-database connection this dump depends on,
  // or the encryption key `createBackup` may be minting for the very first time.
  try {
    await withBackupLock(async () => {
      const result = await createBackup({
        kind: 'scheduled' as BackupKind,
        connection: {
          host: url.hostname,
          port: Number(url.port || 5432),
          user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
          database: decodeURIComponent(url.pathname.replace(/^\//, '')),
        },
        pgBinDir: process.env.APHUB_PG_BIN_DIR ?? join(process.cwd(), 'vendor', 'pgsql', 'bin'),
        exeSuffix: host.exeSuffix,
        backupDir: process.env.APHUB_BACKUP_DIR ?? backupDir,
        restrictToCurrentUser: host.fsPermissions.restrictToCurrentUser,
        secretStore: host.secretStore,
      });
      if (!result.verified) {
        log.error({ backupId: result.backupId, reason: result.reason }, 'nightly backup failed verification');
        alertBackupFailure(
          'AP-Hub made a backup copy but could not confirm it is readable. It was not counted as a usable backup.',
        );
        return; // never prune when the new copy did not verify
      }
      const { prunedIds, skipped } = await pruneBackups();
      log.info({ prunedIds, skippedCount: skipped.length }, 'backup rotation complete');
    });
  } catch (err) {
    log.error({ err: String(err) }, 'nightly backup creation failed; rotation skipped this cycle');
    alertBackupFailure('AP-Hub could not create tonight\'s backup. Your older verified backups were left alone.');
  }
}

export async function scheduleBackupNightly(boss: PgBoss): Promise<void> {
  // Not tenant-scoped — `backups` covers the whole local install, not a tenant.
  // 02:00 UTC: before the 03:00 audit anchor and well off any interactive hours.
  await boss.schedule(JOBS.backup_nightly, '0 2 * * *', {}, { tz: 'UTC' });
}
