import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type pg from 'pg';

/**
 * CHUNK_7_BACKUP — the two things a re-read verification actually checks:
 *
 *   1. `hashFile`: sha256 of the plaintext dump. Computed once right after `pg_dump` produces
 *      it (before encryption), stored as `backups.manifest_hash`, and recomputed after the
 *      backup is decrypted back out during verification. Equality proves the encrypt/decrypt
 *      round trip reproduced the exact dump bytes — not just "some file that decrypts".
 *   2. `captureRowCounts`: counts for a fixed set of tables that hold the user's actual AP
 *      history (messages, attachments, the attachment bytes themselves, proposals, postings).
 *      Captured from the live database at dump time and re-derived from the RESTORED dump
 *      during verification (see `verify.ts`), so a match proves the dump is really restorable,
 *      not merely that the live database didn't change in between.
 */

export const BACKUP_TABLES = [
  'messages',
  'attachments',
  'attachment_blobs',
  'proposals',
  'postings',
] as const;

/** sha256 of a file's bytes, streamed — no whole-file buffering. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * Row counts for a fixed, known-safe set of table names. Table names here are never user
 * input — they come only from `BACKUP_TABLES` or a test-supplied override — so building the
 * query by interpolation is safe; `pg` does not support parameterised identifiers.
 */
export async function captureRowCounts(
  pool: pg.Pool,
  tables: readonly string[] = BACKUP_TABLES,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    counts[table] = Number(rows[0]!.n);
  }
  return counts;
}

/** True when every expected table's count matches the actual count exactly. */
export function rowCountsMatch(
  expected: Record<string, number>,
  actual: Record<string, number>,
): boolean {
  const keys = Object.keys(expected);
  if (keys.length === 0) return false;
  return keys.every((k) => expected[k] === actual[k]);
}
