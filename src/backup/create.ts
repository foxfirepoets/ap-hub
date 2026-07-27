import { randomBytes } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import type { SecretStore } from '../host/types.js';
import { childLogger } from '../logger.js';
import { encryptFile } from './crypto.js';
import { getOrCreateBackupKey } from './key.js';
import { BACKUP_TABLES, captureRowCounts, hashFile } from './manifest.js';
import { runPgTool, PgToolFailed, type PgConnection } from './pg-tools.js';
import { verifyBackup } from './verify.js';

const { Pool } = pg;

const log = childLogger({ module: 'backup' });

/** Matches the `backups.kind` CHECK constraint in migrations/015_backups.sql. */
export const BACKUP_KINDS = ['scheduled', 'pre_migration', 'pre_update', 'manual'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export interface CreateBackupOptions {
  kind: BackupKind;
  connection: PgConnection & { database: string };
  /** Directory containing `pg_dump`, `pg_restore`, `createdb`, `dropdb`. */
  pgBinDir: string;
  /** `.exe` on Windows; injected so this module names no platform. */
  exeSuffix: string;
  /** Directory the encrypted backup file is written into; created if absent. */
  backupDir: string;
  secretStore: SecretStore;
  tables?: readonly string[];
  now?: () => Date;
}

export interface BackupResult {
  backupId: number;
  verified: boolean;
  /** Present only when `verified` is false. */
  reason?: string;
  path: string;
  sizeBytes: number;
  manifestHash: string;
  rowCounts: Record<string, number>;
}

/**
 * Raised only when a backup could not be produced at all — the dump itself failed (e.g. disk
 * full mid-dump). No `backups` row is written in that case: there is no file, no size, and no
 * honest manifest hash to record, so a row would misrepresent what happened. A backup that WAS
 * produced but failed re-read verification is a different, expected outcome — see `BackupResult.verified`.
 */
export class BackupCreateFailed extends Error {
  readonly code = 'BACKUP_FAILED';
  constructor(reason: string, readonly detail?: string) {
    super(reason);
    this.name = 'BackupCreateFailed';
  }
}

/**
 * Produce one encrypted, verified backup of the running local PostgreSQL instance.
 *
 * Order of operations and why:
 *   1. Row counts are captured from the LIVE database first — this is the baseline the
 *      restored dump must reproduce exactly.
 *   2. `pg_dump -Fc` runs against the live, running instance. MVCC gives a consistent
 *      snapshot without stopping the engine or locking anything.
 *   3. The plaintext dump is hashed (the manifest hash), then encrypted with a key that
 *      exists only in the OS credential store, then the plaintext dump is deleted — it never
 *      lingers on disk next to the encrypted artifact.
 *   4. The encrypted file is immediately decrypted back out and restored into a throwaway
 *      database to prove it is really usable (`verify.ts`) — never trusted just because the
 *      write succeeded.
 *   5. A `backups` row is written with the manifest hash and row counts either way;
 *      `verified_at` is set ONLY when step 4 passed. A failed verification is therefore
 *      visible (a row exists) but never counted as usable (`verified_at IS NULL`).
 */
export async function createBackup(opts: CreateBackupOptions): Promise<BackupResult> {
  const now = opts.now ?? (() => new Date());
  const tables = opts.tables ?? BACKUP_TABLES;
  const bin = (name: string) => join(opts.pgBinDir, `${name}${opts.exeSuffix}`);
  const conn: PgConnection = { host: opts.connection.host, port: opts.connection.port, user: opts.connection.user, password: opts.connection.password };

  await mkdir(opts.backupDir, { recursive: true });
  const key = await getOrCreateBackupKey(opts.secretStore);

  const pool = new Pool({
    connectionString: `postgres://${encodeURIComponent(conn.user)}:${encodeURIComponent(conn.password)}@${conn.host}:${conn.port}/${encodeURIComponent(opts.connection.database)}`,
  });

  let dumpPath: string | undefined;
  let encPath: string | undefined;
  try {
    const rowCountsAtDump = await captureRowCounts(pool, tables);

    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const suffix = randomBytes(4).toString('hex');
    dumpPath = join(opts.backupDir, `.aphub-dump-${stamp}-${suffix}.tmp`);
    encPath = join(opts.backupDir, `aphub-backup-${opts.kind}-${stamp}-${suffix}.aphubbak`);

    try {
      await runPgTool(bin, 'pg_dump', ['-Fc', '-f', dumpPath, opts.connection.database], conn, 30 * 60_000);
    } catch (err) {
      const detail = err instanceof PgToolFailed ? err.detail : err instanceof Error ? err.message : String(err);
      log.error({ kind: opts.kind, detail }, 'pg_dump failed; no backup row written');
      throw new BackupCreateFailed('the database could not be dumped', detail);
    }

    const manifestHash = await hashFile(dumpPath);
    await encryptFile(dumpPath, encPath, key);
    const sizeBytes = (await stat(encPath)).size;
    await rm(dumpPath, { force: true });
    dumpPath = undefined;

    const verification = await verifyBackup({
      encPath,
      key,
      expectedManifestHash: manifestHash,
      expectedRowCounts: rowCountsAtDump,
      bin,
      conn,
      tables,
    });

    const verifiedAt = verification.ok ? now() : null;
    const insert = await pool.query<{ id: number }>(
      `INSERT INTO backups (kind, path, size_bytes, manifest_hash, row_counts, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [opts.kind, encPath, sizeBytes, manifestHash, JSON.stringify(rowCountsAtDump), verifiedAt],
    );
    const backupId = insert.rows[0]!.id;

    if (verification.ok) {
      log.info({ kind: opts.kind, backupId, sizeBytes }, 'backup created and verified');
    } else {
      log.error({ kind: opts.kind, backupId, reason: verification.reason }, 'backup verification failed; not counted as usable');
    }

    return {
      backupId,
      verified: verification.ok,
      reason: verification.reason,
      path: encPath,
      sizeBytes,
      manifestHash,
      rowCounts: rowCountsAtDump,
    };
  } finally {
    if (dumpPath) await rm(dumpPath, { force: true });
    await pool.end();
  }
}
