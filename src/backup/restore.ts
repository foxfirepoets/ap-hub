import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { buildConnectionString } from '../db/postgres-runtime.js';
import type { SecretStore } from '../host/types.js';
import { childLogger } from '../logger.js';
import { decryptFile, BackupCorrupted } from './crypto.js';
import { BACKUP_ENCRYPTION_KEY_TARGET } from './key.js';
import { BACKUP_TABLES, captureRowCounts, hashFile, rowCountsMatch } from './manifest.js';
import { runPgTool, type PgConnection, type SecurePgPassDir } from './pg-tools.js';

const { Pool } = pg;

const log = childLogger({ module: 'backup-restore' });

export interface RestoreBackupOptions {
  backupId: number;
  /** The LIVE database to be replaced. Its `backups` table is where `backupId` is looked up. */
  connection: PgConnection & { database: string };
  /** Directory containing `pg_restore`, `createdb`, `dropdb`. */
  pgBinDir: string;
  /** `.exe` on Windows; injected so this module names no platform. */
  exeSuffix: string;
  /** Directory the decrypted staging dump and the short-lived `.pgpass` file are written into. */
  backupDir: string;
  /** Same ACL-hardening primitive `create.ts` uses for its `.pgpass` directory. */
  restrictToCurrentUser: (dir: string) => Promise<void>;
  secretStore: SecretStore;
  tables?: readonly string[];
  now?: () => Date;
}

export interface RestoreResult {
  backupId: number;
  restored: true;
  /** Row counts captured from the LIVE database after the restore completed. */
  rowCounts: Record<string, number>;
  /**
   * The pre-restore database, renamed aside rather than dropped — see the module doc for why.
   * Not exposed over IPC; this is for logs/support, and for a human to drop it once satisfied.
   */
  retiredDatabase: string;
}

/** Raised for every restore failure. The live database is guaranteed untouched unless the
 *  message says otherwise (only the swap-rollback-failure case leaves it in a state that
 *  needs manual attention, and that case says so explicitly). */
export class RestoreFailed extends Error {
  readonly code = 'RESTORE_FAILED';
  constructor(reason: string, readonly detail?: string) {
    super(reason);
    this.name = 'RestoreFailed';
  }
}

/** Raised when the backup encryption key is not in the OS credential store at all — a
 *  different failure than a corrupted file, and not recoverable by retrying the restore. */
export class BackupKeyMissing extends Error {
  readonly code = 'BACKUP_KEY_MISSING';
  constructor() {
    super('the backup encryption key is not available in this computer’s secure storage');
    this.name = 'BackupKeyMissing';
  }
}

/** Only digits — safe to use unquoted in a database name and in a temp file name. */
function digitStamp(d: Date): string {
  return d.toISOString().replace(/[^0-9]/g, '');
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const RENAME_RETRY_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 200;

/** True for the Postgres error raised by ALTER DATABASE ... RENAME while other backends are
 *  still connected (SQLSTATE 55006, "object not in prerequisite state"). A late-arriving
 *  connection between our terminate step and the rename is exactly the race this catches. */
function isDatabaseInUseError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === '55006') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /is being accessed by other users/i.test(message);
}

async function terminateConnections(adminPool: pg.Pool, datname: string): Promise<void> {
  await adminPool.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
    [datname],
  );
}

/** Terminate + rename, retried a few times to absorb a connection racing back in right after
 *  termination and before the rename lands. */
async function renameDatabaseWithRetry(
  adminPool: pg.Pool,
  fromName: string,
  toName: string,
): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_RETRY_ATTEMPTS; attempt++) {
    await terminateConnections(adminPool, fromName);
    try {
      await adminPool.query(`ALTER DATABASE ${quoteIdent(fromName)} RENAME TO ${quoteIdent(toName)}`);
      return;
    } catch (err) {
      if (isDatabaseInUseError(err) && attempt < RENAME_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Replace the LIVE database's contents with a previously-verified backup's contents.
 *
 * Strategy: restore-into-a-fresh-database-then-rename-swap, not restore-in-place with
 * `pg_restore --clean --if-exists`. Both were considered; the rename-swap costs one extra
 * `createdb` and two `ALTER DATABASE ... RENAME` statements, and buys a real safety property
 * the in-place option cannot: the CURRENT live data is never touched until a fully-restored,
 * row-count-verified replacement already exists and is sitting right next to it. If the dump
 * is bad, the restore hangs, or the post-restore row-count check fails, the live database is
 * still exactly what it was when this function was called — there is no window where the live
 * database has been `--clean`ed but not yet fully repopulated. For "the failure mode this
 * chunk exists to prevent is a backup that appears to work and turns out to be unrestorable"
 * (spec summary), never having a half-restored live database is worth the extra complexity.
 *
 * Order of operations, and why each one is where it is:
 *   1. Look up the `backups` row and require `verified_at IS NOT NULL` — refuse to restore
 *      from a backup that was never counted as usable, before touching anything else.
 *   2. Decrypt the archive and re-check its manifest hash. This is the SAME tamper/corruption
 *      detection `verify.ts` relies on (GCM authentication in `crypto.ts`, plus the hash
 *      comparison) applied again here, at restore time — a disk that corrupted the file
 *      between backup-creation and restore is caught here, before any database is touched.
 *   3. `createdb` a throwaway staging database and `pg_restore` into it. Still no live-database
 *      contact.
 *   4. Row-count-verify the staging database against `backups.row_counts`. This is "verify
 *      after restore, not just before" — even though `createBackup` already verified this
 *      backup once, the restored bytes are re-checked again right now, against the row counts
 *      recorded at backup time.
 *   5. Only now: terminate other connections to the live database, rename it aside, rename the
 *      staging database into its place. If the second rename fails after the first succeeded,
 *      the rename is rolled back so the live database keeps its original name and contents.
 *   6. A final sanity read against the now-live database, closing the loop the spec asks for.
 *
 * The pre-restore database is renamed aside, never dropped, so a human always has one more
 * chance to recover from it even after a restore that later turns out to have gone wrong in
 * some way this function's own checks didn't catch. Pruning retired databases is a follow-up
 * concern (rotation/cleanup), not this function's job.
 */
export async function restoreBackup(opts: RestoreBackupOptions): Promise<RestoreResult> {
  const now = opts.now ?? (() => new Date());
  const tables = opts.tables ?? BACKUP_TABLES;
  const bin = (name: string) => join(opts.pgBinDir, `${name}${opts.exeSuffix}`);
  const conn: PgConnection = {
    host: opts.connection.host,
    port: opts.connection.port,
    user: opts.connection.user,
    password: opts.connection.password,
  };
  const liveDb = opts.connection.database;
  const secureDir: SecurePgPassDir = {
    dir: join(opts.backupDir, '.pgpass'),
    restrictToCurrentUser: opts.restrictToCurrentUser,
  };

  await mkdir(opts.backupDir, { recursive: true });

  const keyB64 = await opts.secretStore.get(BACKUP_ENCRYPTION_KEY_TARGET);
  if (keyB64 === null) throw new BackupKeyMissing();
  const key = Buffer.from(keyB64, 'base64url');
  if (key.length !== 32) {
    throw new RestoreFailed('the stored backup encryption key is invalid');
  }

  // 1. Look up the backup row on the LIVE database, before anything else is touched.
  const livePoolForLookup = new Pool({
    connectionString: buildConnectionString({ user: conn.user, password: conn.password, port: conn.port, database: liveDb }),
  });
  let backupRow: { path: string; manifest_hash: string; row_counts: Record<string, number>; verified_at: Date | null } | undefined;
  try {
    const { rows } = await livePoolForLookup.query<{
      path: string;
      manifest_hash: string;
      row_counts: Record<string, number>;
      verified_at: Date | null;
    }>('SELECT path, manifest_hash, row_counts, verified_at FROM backups WHERE id = $1', [opts.backupId]);
    backupRow = rows[0];
  } finally {
    await livePoolForLookup.end();
  }
  if (!backupRow) {
    throw new RestoreFailed(`no backup found with id ${opts.backupId}`);
  }
  if (backupRow.verified_at === null) {
    throw new RestoreFailed('refusing to restore from a backup that never verified — choose another backup');
  }

  const stamp = digitStamp(now());
  const decPath = join(opts.backupDir, `.aphub-restore-${stamp}.tmp`);
  const stagingDb = `aphub_restore_${stamp}`;
  const retiredDb = `${liveDb}_pre_restore_${stamp}`;
  let stagingDbPending = false;

  try {
    // 2. Decrypt + manifest-hash check. Both are the tamper/corruption detection this restore
    //    depends on, and both happen before any database is created, dropped or renamed.
    try {
      await decryptFile(backupRow.path, decPath, key);
    } catch (err) {
      if (err instanceof BackupCorrupted) {
        throw new RestoreFailed('the backup file failed integrity verification and was not restored', err.message);
      }
      throw err;
    }
    const actualHash = await hashFile(decPath);
    if (actualHash !== backupRow.manifest_hash) {
      throw new RestoreFailed('the backup content does not match its recorded manifest hash; restore refused');
    }

    // 3. Restore into a fresh, throwaway staging database. The live database is still untouched.
    try {
      await runPgTool(bin, 'createdb', [stagingDb], conn, secureDir);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new RestoreFailed('could not create a staging database for restore', detail);
    }
    stagingDbPending = true;

    try {
      await runPgTool(bin, 'pg_restore', ['-d', stagingDb, decPath], conn, secureDir, 300_000);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new RestoreFailed('restoring the backup into a staging database failed', detail);
    }

    // 4. Verify after restore — row counts on the RESTORED staging database, before it ever
    //    becomes the live database.
    const stagingPool = new Pool({
      connectionString: buildConnectionString({ user: conn.user, password: conn.password, port: conn.port, database: stagingDb }),
    });
    try {
      const stagingCounts = await captureRowCounts(stagingPool, tables);
      if (!rowCountsMatch(backupRow.row_counts, stagingCounts)) {
        throw new RestoreFailed('row counts in the restored backup do not match its manifest; restore refused');
      }
    } finally {
      await stagingPool.end();
    }

    // 5. The swap. Everything before this point could fail with the live database completely
    //    untouched; everything from here on is designed to either complete or roll itself back.
    const adminPool = new Pool({
      connectionString: buildConnectionString({ user: conn.user, password: conn.password, port: conn.port, database: 'postgres' }),
    });
    let liveRenamedAside = false;
    try {
      await renameDatabaseWithRetry(adminPool, liveDb, retiredDb);
      liveRenamedAside = true;
      await renameDatabaseWithRetry(adminPool, stagingDb, liveDb);
      stagingDbPending = false; // it is now the live database; do not drop it in the finally below
    } catch (err) {
      if (liveRenamedAside) {
        try {
          await renameDatabaseWithRetry(adminPool, retiredDb, liveDb);
        } catch (rollbackErr) {
          const rollbackDetail = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          log.error(
            { liveDb, retiredDb, stagingDb, rollbackDetail },
            'restore rollback failed — the live database is currently named as the retired database and needs manual renaming',
          );
          throw new RestoreFailed(
            `restore left the database in an inconsistent state: the database currently named "${retiredDb}" ` +
              `must be renamed back to "${liveDb}" manually. The restored copy is intact at "${stagingDb}".`,
            rollbackDetail,
          );
        }
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new RestoreFailed('swapping the restored database into place failed; the live database was not changed', detail);
    } finally {
      await adminPool.end();
    }

    // 6. Final sanity check against the now-live database — closing the loop end to end.
    const livePool = new Pool({
      connectionString: buildConnectionString({ user: conn.user, password: conn.password, port: conn.port, database: liveDb }),
    });
    try {
      const finalCounts = await captureRowCounts(livePool, tables);
      if (!rowCountsMatch(backupRow.row_counts, finalCounts)) {
        throw new RestoreFailed(
          'the live database was replaced but its post-restore row counts do not match the backup manifest',
        );
      }
      log.info({ backupId: opts.backupId, liveDb, retiredDb, rowCounts: finalCounts }, 'restore completed and verified');
      return { backupId: opts.backupId, restored: true, rowCounts: finalCounts, retiredDatabase: retiredDb };
    } finally {
      await livePool.end();
    }
  } finally {
    await rm(decPath, { force: true });
    if (stagingDbPending) {
      await runPgTool(bin, 'dropdb', ['--if-exists', stagingDb], conn, secureDir).catch((err) => {
        log.error({ stagingDb, err: err instanceof Error ? err.message : String(err) }, 'failed to drop abandoned staging database');
      });
    }
  }
}
