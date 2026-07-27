import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, closePool } from '../src/db/pool.js';
import { selectBackupsToPrune, pruneBackups, type BackupRow } from '../src/backup/rotation.js';

/**
 * CHUNK_7_BACKUP rotation — pure bucketing/selection logic plus a real-file,
 * real-Postgres proof that the prune-execution function only ever deletes what the
 * selection function said to delete, and never below one verified copy.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgoDate(now: Date, n: number): Date {
  return new Date(now.getTime() - n * DAY_MS);
}

let seq = 0;
function row(overrides: Partial<BackupRow> & { ageDays: number }): BackupRow {
  const now = new Date('2026-07-27T12:00:00Z');
  seq += 1;
  return {
    id: overrides.id ?? seq,
    kind: overrides.kind ?? 'scheduled',
    path: overrides.path ?? `C:/backups/backup-${seq}.aphubbak`,
    size_bytes: 100,
    manifest_hash: 'hash',
    row_counts: {},
    verified_at: overrides.verified_at === undefined ? daysAgoDate(now, overrides.ageDays) : overrides.verified_at,
    external_copy: null,
    created_at: daysAgoDate(now, overrides.ageDays),
  };
}

const NOW = new Date('2026-07-27T12:00:00Z');

describe('selectBackupsToPrune — pure bucketing logic', () => {
  it('keeps exactly the 7 most recent daily backups and prunes an 8th distinct-day backup', () => {
    const daily = Array.from({ length: 7 }, (_, i) => row({ ageDays: i })); // ages 0..6
    const eighth = row({ ageDays: 7 }); // falls into the weekly window instead, not daily
    const overflow = row({ ageDays: 200 }); // well past every bucket
    const result = selectBackupsToPrune([...daily, eighth, overflow], NOW);
    const prunedIds = new Set(result.map((r) => r.id));

    for (const d of daily) expect(prunedIds.has(d.id)).toBe(false);
    // age 7 lands in the weekly bucket (idx 0) and is kept there, not pruned.
    expect(prunedIds.has(eighth.id)).toBe(false);
    expect(prunedIds.has(overflow.id)).toBe(true);
  });

  it('keeps only the newest backup within each weekly and monthly bucket', () => {
    // Two backups in the same weekly bucket (ages 8 and 10 both -> idx floor((age-7)/7)=0/... )
    const weekOlder = row({ ageDays: 10 });
    const weekNewer = row({ ageDays: 8 });
    // Two backups in the same monthly bucket (ages 40 and 45 -> idx floor((age-35)/30)=0)
    const monthOlder = row({ ageDays: 45 });
    const monthNewer = row({ ageDays: 40 });
    const anchor = row({ ageDays: 0 }); // keeps the "newest overall" invariant out of the way

    const result = selectBackupsToPrune([weekOlder, weekNewer, monthOlder, monthNewer, anchor], NOW);
    const prunedIds = new Set(result.map((r) => r.id));

    expect(prunedIds.has(weekOlder.id)).toBe(true);
    expect(prunedIds.has(weekNewer.id)).toBe(false);
    expect(prunedIds.has(monthOlder.id)).toBe(true);
    expect(prunedIds.has(monthNewer.id)).toBe(false);
  });

  it('retains every pre_update backup regardless of age', () => {
    const ancient = row({ ageDays: 500, kind: 'pre_update' });
    const anchor = row({ ageDays: 0 });
    const result = selectBackupsToPrune([ancient, anchor], NOW);
    expect(result.some((r) => r.id === ancient.id)).toBe(false);
  });

  it('never prunes the newest verified backup even when it is the only one and very old', () => {
    const onlyOne = row({ ageDays: 900 });
    const result = selectBackupsToPrune([onlyOne], NOW);
    expect(result).toEqual([]);
  });

  it('never prunes the single newest verified backup overall, even when it falls outside every bucket window', () => {
    // All three ages (200, 300, 500) are past the monthly cutoff (125 days), so bucketing
    // alone would keep none of them. The 200-day-old row is still the NEWEST of the three,
    // so the override must keep it while the two older ones are pruned.
    const outOfWindowOlder = row({ ageDays: 300 });
    const outOfWindowOldest = row({ ageDays: 500 });
    const newestButStillOutOfBuckets = row({ ageDays: 200 });
    const result = selectBackupsToPrune(
      [outOfWindowOlder, outOfWindowOldest, newestButStillOutOfBuckets],
      NOW,
    );
    expect(result.some((r) => r.id === newestButStillOutOfBuckets.id)).toBe(false);
    expect(result.some((r) => r.id === outOfWindowOlder.id)).toBe(true);
    expect(result.some((r) => r.id === outOfWindowOldest.id)).toBe(true);
  });

  it('never selects unverified rows for pruning or counts them toward a kept bucket slot', () => {
    const unverifiedRecent = row({ ageDays: 0, verified_at: null });
    const unverifiedOld = row({ ageDays: 300, verified_at: null });
    const onlyVerified = row({ ageDays: 50 });
    const result = selectBackupsToPrune([unverifiedRecent, unverifiedOld, onlyVerified], NOW);
    // Unverified rows never appear in the prune list (they were never candidates)...
    expect(result.some((r) => r.id === unverifiedRecent.id)).toBe(false);
    expect(result.some((r) => r.id === unverifiedOld.id)).toBe(false);
    // ...and the one verified row is the newest-overall, so it is kept too.
    expect(result.some((r) => r.id === onlyVerified.id)).toBe(false);
  });

  it('returns nothing to prune when there are no verified backups at all', () => {
    const result = selectBackupsToPrune([row({ ageDays: 10, verified_at: null })], NOW);
    expect(result).toEqual([]);
  });
});

describe('pruneBackups — real Postgres + real files', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aphub-rotation-int-'));
    await query('TRUNCATE backups RESTART IDENTITY');
  });

  afterAll(async () => {
    await closePool().catch(() => {});
  });

  async function insertRow(opts: {
    kind?: string;
    ageDays: number;
    verified: boolean;
  }): Promise<{ id: number; path: string }> {
    const filePath = join(dir, `backup-${opts.ageDays}-${opts.kind ?? 'scheduled'}-${Math.random().toString(36).slice(2)}.aphubbak`);
    writeFileSync(filePath, 'dummy-encrypted-content');
    const createdAt = daysAgoDate(NOW, opts.ageDays);
    const verifiedAt = opts.verified ? createdAt : null;
    const { rows } = await query<{ id: number }>(
      `INSERT INTO backups (kind, path, size_bytes, manifest_hash, row_counts, verified_at, created_at)
       VALUES ($1,$2,$3,'hash','{}'::jsonb,$4,$5) RETURNING id`,
      [opts.kind ?? 'scheduled', filePath, 100, verifiedAt, createdAt],
    );
    return { id: rows[0]!.id, path: filePath };
  }

  it('deletes only the rows/files selectBackupsToPrune identified, keeping the rest on disk and in the table', async () => {
    const keepDaily = await insertRow({ ageDays: 0, verified: true });
    const toPrune = await insertRow({ ageDays: 400, verified: true });
    const keepPreUpdate = await insertRow({ kind: 'pre_update', ageDays: 400, verified: true });
    const untouchedUnverified = await insertRow({ ageDays: 400, verified: false });

    const result = await pruneBackups({ now: () => NOW });

    expect(result.prunedIds).toEqual([toPrune.id]);
    expect(existsSync(toPrune.path)).toBe(false);
    const remaining = await query<{ id: number }>('SELECT id FROM backups ORDER BY id');
    expect(remaining.rows.map((r) => r.id).sort((a, b) => a - b)).toEqual(
      [keepDaily.id, keepPreUpdate.id, untouchedUnverified.id].sort((a, b) => a - b),
    );

    expect(existsSync(keepDaily.path)).toBe(true);
    expect(existsSync(keepPreUpdate.path)).toBe(true);
    expect(existsSync(untouchedUnverified.path)).toBe(true);
  });

  it('never deletes the last verified copy, proven against a real single-row table', async () => {
    const onlyVerified = await insertRow({ ageDays: 900, verified: true });

    const result = await pruneBackups({ now: () => NOW });

    expect(result.prunedIds).toEqual([]);
    expect(existsSync(onlyVerified.path)).toBe(true);
    const remaining = await query<{ id: number }>('SELECT id FROM backups');
    expect(remaining.rows).toHaveLength(1);
  });

  it('never deletes both of two old backups if one is still the newest-overall (real DB, exercises the loop with >1 candidate)', async () => {
    const newer = await insertRow({ ageDays: 400, verified: true }); // newest of the two -> kept
    const older = await insertRow({ ageDays: 401, verified: true }); // prunable

    const result = await pruneBackups({ now: () => NOW });

    expect(result.prunedIds).toEqual([older.id]);
    expect(existsSync(newer.path)).toBe(true);
    expect(existsSync(older.path)).toBe(false);
    const remaining = await query<{ id: number }>('SELECT id FROM backups');
    expect(remaining.rows.map((r) => r.id)).toEqual([newer.id]);
  });
});

describe('pruneBackups — re-checks safety immediately before each delete (injected deps)', () => {
  it('re-queries and re-runs selection before every individual delete, not just once up front', async () => {
    const now = new Date('2026-07-27T12:00:00Z');
    const rowA: BackupRow = {
      id: 1,
      kind: 'scheduled',
      path: '/fake/a.aphubbak',
      size_bytes: 1,
      manifest_hash: 'h',
      row_counts: {},
      verified_at: daysAgoDate(now, 5), // newest -> always kept
      external_copy: null,
      created_at: daysAgoDate(now, 5),
    };
    const rowB: BackupRow = {
      ...rowA,
      id: 2,
      path: '/fake/b.aphubbak',
      verified_at: daysAgoDate(now, 400),
      created_at: daysAgoDate(now, 400),
    };
    const rowC: BackupRow = {
      ...rowA,
      id: 3,
      path: '/fake/c.aphubbak',
      verified_at: daysAgoDate(now, 500),
      created_at: daysAgoDate(now, 500),
    };

    let queryCalls = 0;
    const table = [rowA, rowB, rowC];
    const deleted: number[] = [];
    const unlinked: string[] = [];

    const fakeQuery = (async (text: string, params?: unknown[]) => {
      queryCalls += 1;
      if (text.startsWith('DELETE')) {
        const id = (params as [number])[0];
        deleted.push(id);
        const idx = table.findIndex((r) => r.id === id);
        if (idx >= 0) table.splice(idx, 1);
        return { rows: [] } as any;
      }
      return { rows: table } as any;
    }) as typeof query;

    const result = await pruneBackups({
      query: fakeQuery,
      unlink: async (p: string) => {
        unlinked.push(p);
      },
      now: () => now,
    });

    // Both B and C are prunable (A is newest-overall). Every candidate must trigger its own
    // fresh SELECT re-check right before its DELETE: 1 initial SELECT + (SELECT + DELETE) per
    // pruned candidate = 1 + 2*2 = 5 query() calls, never just 1 upfront + blind deletes.
    expect(queryCalls).toBe(5);
    expect(result.prunedIds.sort()).toEqual([2, 3]);
    expect(deleted.sort()).toEqual([2, 3]);
    expect(unlinked.sort()).toEqual(['/fake/b.aphubbak', '/fake/c.aphubbak']);
  });
});
