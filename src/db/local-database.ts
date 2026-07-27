import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import type { SecretStore, SupportedPlatform } from '../host/types.js';
import { childLogger } from '../logger.js';
import { probeFreePort, isPortFree, PORT_PROBE_START } from './bootstrap.js';
import {
  PostgresRuntime,
  PostgresStartFailed,
  buildConnectionString,
  generateDatabasePassword,
  isInitialisedCluster,
} from './postgres-runtime.js';
import { migrateUp } from './migrate.js';
import { parseInstallFile, serializeInstallFile, type InstallFile } from '../install/install-file.js';
import {
  clearRestoreSwapMarker,
  readRestoreSwapMarker,
  renameDatabaseWithRetry,
} from '../backup/restore.js';

/**
 * CHUNK_2_DATABASE — first launch, every launch.
 *
 * This is the module that turns "PostgreSQL binaries are on disk" into "the engine has a
 * migrated database", without the user ever seeing a port, a password or a migration.
 *
 * The ordering here is the design, not an implementation detail. Three rules fix it:
 *
 *   1. **The password reaches the credential store before `initdb` runs.** Reverse those and
 *      an interruption in between leaves a cluster whose password exists nowhere — which is
 *      unrecoverable data loss on the very first launch, before the user has anything to lose
 *      but immediately after they have granted access to their email.
 *   2. **`install.json` is written last, and atomically.** It is the file the next launch
 *      trusts, so it must never describe a state that was not reached. A half-written one is
 *      worse than an absent one, because absent is recoverable by re-deriving.
 *   3. **The recorded port is a preference, not a promise.** Ports are not stable across
 *      reboots — something else may have taken ours. Re-probing and re-recording is correct;
 *      refusing to start because the old port is busy is not.
 *
 * OS-neutral by construction: every path, the executable suffix and the platform identifier
 * are injected by the caller, so `lint:noleak` stays green.
 */

const { Pool } = pg;

const log = childLogger({ module: 'local-database' });

/** Credential-store target for the bundled cluster's superuser password. */
export const DATABASE_PASSWORD_TARGET = 'APHub/database/superuser';

/**
 * Raised when a cluster exists but its password does not. The cluster cannot be opened and
 * must not be silently deleted — it is the user's accounting history. This routes to repair.
 */
export class DatabasePasswordLost extends Error {
  readonly code = 'DB_FAILED';
  constructor() {
    super('The database exists but its stored password is missing; restore or repair is required');
    this.name = 'DatabasePasswordLost';
  }
}

/**
 * Raised when the identity recorded for this install — in `install.json`, or recovered from
 * the database when that file was unreadable — belongs to a DIFFERENT OS account than the one
 * currently running (CHUNK_4_IDENTITY). This must fail closed: proceeding would open one
 * account's information under another account's name. There is no repair path here, because
 * there is nothing wrong to repair — the running account is simply not the owner.
 */
export class OsAccountMismatch extends Error {
  readonly code = 'OS_ACCOUNT_MISMATCH';
  constructor() {
    super('This install belongs to a different OS account than the one currently running');
    this.name = 'OsAccountMismatch';
  }
}

/**
 * Raised when a restore's rename-swap (`src/backup/restore.ts`) was interrupted by a hard crash
 * — the live-named database is missing and the pre-restore database was found retired under a
 * `_pre_restore_` name — but renaming that retired database back to the live name itself fails.
 * This is the one case this chunk cannot resolve automatically: both the orphaned pre-restore
 * data and (usually) a fully-restored copy still exist on disk, but neither can be put back
 * under the live name without help. It must fail loudly, never silently create an empty database.
 */
export class RestoreSwapRecoveryFailed extends Error {
  readonly code = 'DB_FAILED';
  constructor(readonly pending: PendingRestoreSwap, readonly detail?: string) {
    super(
      `A previous restore was interrupted mid-swap and automatic recovery failed. The database ` +
        `currently named "${pending.retiredDb}" holds your pre-restore data and must be renamed ` +
        `to "${pending.liveDb}" manually before AP-Hub can start.`,
    );
    this.name = 'RestoreSwapRecoveryFailed';
  }
}

export interface LocalDatabaseOptions {
  /** Directory holding `initdb`, `postgres`, `pg_ctl`, `pg_isready`. */
  binDir: string;
  /** Private cluster directory, owned exclusively by this install. */
  dataDir: string;
  /** Absolute path of `install.json`. */
  installFilePath: string;
  /** Log directory recorded in `install.json`; created if absent. */
  logDir: string;
  /** `.exe` on Windows. Injected so this module names no platform. */
  exeSuffix: string;
  /**
   * Value persisted to `install.json.platform` and `local_install.platform`. Typed as what
   * Version 1 SUPPORTS, not what the schema can hold — so a caller running on an out-of-scope
   * platform cannot reach this function at all.
   */
  platform: SupportedPlatform;
  appVersion: string;
  osAccountId: string;
  secretStore: SecretStore;

  /** Seams for tests — never supplied in production. */
  runtimeFactory?: (o: {
    binDir: string;
    dataDir: string;
    port: number;
    exeSuffix: string;
  }) => LocalPostgres;
  probe?: (from: number) => Promise<number>;
  portIsFree?: (port: number) => Promise<boolean>;
  migrate?: (connectionString: string) => Promise<string[]>;
  createDatabaseIfMissing?: (adminUrl: string, database: string) => Promise<boolean>;
  /**
   * Detects an interrupted restore rename-swap: the live-named database missing while a
   * `<liveDb>_pre_restore_*` database is still present. Must be checked, and resolved via
   * `recoverInterruptedRestoreSwap`, BEFORE `createDatabaseIfMissing` runs — that function
   * would otherwise silently create a fresh empty database and the interrupted swap's orphaned
   * data would never be looked for again.
   */
  detectInterruptedRestoreSwap?: (adminUrl: string, liveDb: string) => Promise<PendingRestoreSwap | null>;
  /** Renames the retired (pre-restore) database back to the live name. */
  recoverInterruptedRestoreSwap?: (adminUrl: string, pending: PendingRestoreSwap) => Promise<void>;
  recordInstallRow?: (connectionString: string, row: InstallFile) => Promise<void>;
  /** Recover an identity from the `local_install` row when install.json could not be read. */
  fetchRecordedInstall?: (connectionString: string) => Promise<RecordedInstall | null>;
  /**
   * Whether `local_install` already exists on this connection (CHUNK_7 ordering fix). Lets the
   * recovered-identity check run BEFORE `migrate()` on any cluster that has already reached
   * migration 014_local_install.sql or later — see the comment at the call site.
   */
  recordedInstallTableExists?: (connectionString: string) => Promise<boolean>;
}

/** The slice of the `local_install` row CHUNK_4's corrupted-file recovery needs. */
export interface RecordedInstall {
  installId: string;
  osAccountId: string;
}

/** An interrupted restore rename-swap, detected at boot — enough to recover from. */
export interface PendingRestoreSwap {
  liveDb: string;
  retiredDb: string;
}

/** The slice of `PostgresRuntime` this orchestrator depends on. */
export interface LocalPostgres {
  readonly user: string;
  readonly database: string;
  initialise(password: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  connectionString(password: string): string;
}

export interface StartedLocalDatabase {
  port: number;
  connectionString: string;
  postgres: LocalPostgres;
  install: InstallFile;
  appliedMigrations: string[];
  /** True when this launch created the cluster. */
  initialised: boolean;
}

/** Read and validate `install.json`, or null when absent. A corrupt file is a hard failure. */
export function readInstallFile(path: string): InstallFile | null {
  if (!existsSync(path)) return null;
  return parseInstallFile(readFileSync(path, 'utf8'));
}

/**
 * `readInstallFile`, but a bad file never crashes the launch (CHUNK_4_IDENTITY spec's edge
 * case). "Bad" covers everything `readInstallFile` throws on: truncated JSON, a missing field,
 * a credential-shaped key or value, or a `dbPort` outside 1024-65535. Every one of those is
 * treated as ABSENT here — the caller recovers the identity from the database instead (see
 * `fetchRecordedInstall` in `startLocalDatabase`) or mints a fresh one, and a clean
 * `install.json` is written at the end of the same launch either way.
 *
 * `readInstallFile` itself keeps throwing for callers that inspect it directly — this
 * tolerance lives only at the one call site that must never let a bad file abort startup.
 */
function readInstallFileTolerantly(path: string): InstallFile | null {
  try {
    return readInstallFile(path);
  } catch {
    return null;
  }
}

/** Recover install identity from the database when install.json could not supply it. */
async function defaultFetchRecordedInstall(connectionString: string): Promise<RecordedInstall | null> {
  const pool = new Pool({ connectionString });
  try {
    const { rows } = await pool.query<{ install_id: string; os_account_id: string }>(
      'SELECT install_id, os_account_id FROM local_install WHERE id = 1',
    );
    const row = rows[0];
    return row ? { installId: row.install_id, osAccountId: row.os_account_id } : null;
  } finally {
    await pool.end();
  }
}

/**
 * Whether `local_install` already exists — a targeted, read-only catalog lookup, safe to run
 * before `migrate()` because it does not depend on the schema being at any particular version.
 */
async function defaultRecordedInstallTableExists(connectionString: string): Promise<boolean> {
  const pool = new Pool({ connectionString });
  try {
    const { rows } = await pool.query<{ exists: boolean }>(
      "SELECT to_regclass('public.local_install') IS NOT NULL AS exists",
    );
    return rows[0]?.exists ?? false;
  } finally {
    await pool.end();
  }
}

/**
 * Write `install.json` atomically. A torn write here would be read by the next launch as
 * authoritative, so the file is only ever swapped into place complete.
 */
export function writeInstallFile(path: string, file: InstallFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serializeInstallFile(file), { encoding: 'utf8' });
  renameSync(tmp, path);
}

/**
 * Choose the port. Prefer the one already recorded — reusing it keeps a firewall prompt or a
 * user-approved exception valid across launches — but only if it is actually free now.
 */
export async function choosePort(
  recorded: number | undefined,
  deps: { probe?: (from: number) => Promise<number>; portIsFree?: (p: number) => Promise<boolean> } = {},
): Promise<number> {
  const free = deps.portIsFree ?? isPortFree;
  const probe = deps.probe ?? ((from: number) => probeFreePort({ from }));
  if (recorded !== undefined && recorded !== 5432 && (await free(recorded))) return recorded;
  return probe(PORT_PROBE_START);
}

/** Escape a value for a Postgres `LIKE` pattern, so a literal name with `_` or `%` in it cannot
 *  match more broadly than intended. */
function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Detect an interrupted restore rename-swap (`src/backup/restore.ts`'s two-statement swap,
 * killed between the renames). Two signals are checked, in order:
 *
 *   1. The marker `restoreBackup` writes before the swap begins, naming the exact retired
 *      database it created. This is the precise, preferred signal.
 *   2. A `pg_database` scan for a `<liveDb>_pre_restore_*` name, as a defense-in-depth backstop
 *      for the case where the marker file itself was lost (e.g. the same disk-full event that
 *      interrupted the swap). If more than one is found (multiple interrupted restores over
 *      time, never cleaned up), the most recent by its timestamp suffix is used.
 *
 * Either way, this only fires when the live-named database is ACTUALLY missing — a stale marker
 * sitting beside a perfectly live database (the swap finished but the marker's own deletion
 * lost the race with a crash) is not this function's problem; it means nothing to recover.
 */
async function defaultDetectInterruptedRestoreSwap(
  adminUrl: string,
  liveDb: string,
  dataDir: string,
): Promise<PendingRestoreSwap | null> {
  const pool = new Pool({ connectionString: adminUrl });
  try {
    const live = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [liveDb]);
    if ((live.rowCount ?? 0) > 0) return null; // live database exists — nothing interrupted

    const marker = readRestoreSwapMarker(dataDir);
    if (marker && marker.liveDb === liveDb) {
      const retired = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [marker.retiredDb]);
      if ((retired.rowCount ?? 0) > 0) {
        return { liveDb, retiredDb: marker.retiredDb };
      }
    }

    // Backstop: no usable marker. Scan for an orphaned retired database by name; the timestamp
    // suffix (`digitStamp` in restore.ts) is fixed-width digits, so lexicographic DESC order is
    // also chronological order.
    const pattern = `${escapeLikeLiteral(liveDb)}${escapeLikeLiteral('_pre_restore_')}%`;
    const { rows } = await pool.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE $1 ESCAPE '\\' ORDER BY datname DESC`,
      [pattern],
    );
    const retiredDb = rows[0]?.datname;
    return retiredDb ? { liveDb, retiredDb } : null;
  } finally {
    await pool.end();
  }
}

/** Rename the retired (pre-restore) database back to the live name — the safest possible
 *  recovery, since it means "the restore attempt effectively didn't happen" rather than
 *  inventing a new empty database. The fully-restored copy (`aphub_restore_*`, if it still
 *  exists) is intentionally left in place; cleaning it up automatically is a follow-up. */
async function defaultRecoverInterruptedRestoreSwap(adminUrl: string, pending: PendingRestoreSwap): Promise<void> {
  const pool = new Pool({ connectionString: adminUrl });
  try {
    await renameDatabaseWithRetry(pool, pending.retiredDb, pending.liveDb);
  } finally {
    await pool.end();
  }
}

/** Create the application database if `initdb` did not (it never does). Idempotent. */
async function defaultCreateDatabase(adminUrl: string, database: string): Promise<boolean> {
  const pool = new Pool({ connectionString: adminUrl });
  try {
    const { rowCount } = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (rowCount && rowCount > 0) return false;
    // Identifier, not a value — parameters are not accepted here, so it is quoted instead.
    await pool.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
    return true;
  } finally {
    await pool.end();
  }
}

/** Upsert the singleton `local_install` row so the database agrees with `install.json`. */
async function defaultRecordInstallRow(connectionString: string, row: InstallFile): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    await pool.query(
      `INSERT INTO local_install (id, install_id, os_account_id, platform, app_version, db_port)
       VALUES (1, $1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         install_id    = EXCLUDED.install_id,
         os_account_id = EXCLUDED.os_account_id,
         platform      = EXCLUDED.platform,
         app_version   = EXCLUDED.app_version,
         db_port       = EXCLUDED.db_port,
         updated_at    = now()`,
      [row.installId, row.osAccountId, row.platform, row.appVersion, row.dbPort],
    );
  } finally {
    await pool.end();
  }
}

/**
 * Bring the private database up and hand back a migrated connection string.
 *
 * Safe to call on every launch: initialisation, database creation, migration and the
 * `local_install` upsert are each idempotent.
 */
export async function startLocalDatabase(opts: LocalDatabaseOptions): Promise<StartedLocalDatabase> {
  const existing = readInstallFileTolerantly(opts.installFilePath);

  // Fail closed, before anything else — before even the password is looked up. A readable
  // install.json naming a different OS account than the one running now must never be treated
  // as this account's own: opening it would show one account's information under another
  // account's name (CHUNK_4_IDENTITY).
  if (existing !== null && existing.osAccountId !== opts.osAccountId) {
    throw new OsAccountMismatch();
  }

  const clusterExists = isInitialisedCluster(opts.dataDir);

  // 1. The password, before anything is created. A cluster that exists without one cannot be
  //    opened, and deleting it to "fix" that would destroy the user's accounting history.
  let password = await opts.secretStore.get(DATABASE_PASSWORD_TARGET);
  if (password === null) {
    if (clusterExists) throw new DatabasePasswordLost();
    password = generateDatabasePassword();
    await opts.secretStore.put(DATABASE_PASSWORD_TARGET, password);
  }

  // 2. The port. Recorded value is a preference; a busy one is re-probed, never fatal.
  const port = await choosePort(existing?.dbPort, { probe: opts.probe, portIsFree: opts.portIsFree });

  const postgres: LocalPostgres = opts.runtimeFactory
    ? opts.runtimeFactory({ binDir: opts.binDir, dataDir: opts.dataDir, port, exeSuffix: opts.exeSuffix })
    : new PostgresRuntime({
        binDir: opts.binDir,
        dataDir: opts.dataDir,
        port,
        exeSuffix: opts.exeSuffix,
      });

  // 3. Initialise (no-op when the cluster is already ours) and start.
  await postgres.initialise(password);
  await postgres.start();

  const adminUrl = buildConnectionString({
    user: postgres.user,
    password,
    port,
    database: 'postgres',
  });

  // 3.5. Crash-recovery: an interrupted restore rename-swap (`src/backup/restore.ts`) must
  //      never be resolved by silently creating an empty live-named database. Checked BEFORE
  //      `createDatabaseIfMissing` below — that function's own "missing means create fresh"
  //      logic is exactly the silent-data-loss path this closes. When triggered, the retired
  //      (pre-restore) database is renamed back to the live name, restoring the safest possible
  //      state — "the restore attempt effectively didn't happen" — and the swap marker is
  //      cleared. A fully-restored copy from that same restore attempt, if one exists, is left
  //      in place untouched (see `defaultRecoverInterruptedRestoreSwap`).
  const detectSwap = opts.detectInterruptedRestoreSwap ?? defaultDetectInterruptedRestoreSwap;
  const pendingSwap = clusterExists
    ? await detectSwap(adminUrl, postgres.database, opts.dataDir)
    : null;
  if (pendingSwap) {
    const recoverSwap = opts.recoverInterruptedRestoreSwap ?? defaultRecoverInterruptedRestoreSwap;
    try {
      await recoverSwap(adminUrl, pendingSwap);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new RestoreSwapRecoveryFailed(pendingSwap, detail);
    }
    await clearRestoreSwapMarker(opts.dataDir).catch(() => {
      // The rename already succeeded — a marker that fails to clear is stale-but-harmless
      // noise, not a reason to fail a launch that just recovered real data.
    });
    log.warn(
      { liveDb: pendingSwap.liveDb, retiredDb: pendingSwap.retiredDb },
      'recovered from an interrupted restore: renamed the pre-restore database back to the live name',
    );
  }

  // 4. The application database. `initdb` creates only postgres/template0/template1.
  const createDb = opts.createDatabaseIfMissing ?? defaultCreateDatabase;
  await createDb(adminUrl, postgres.database);

  const connectionString = postgres.connectionString(password);

  // 5. Identity, recovered path — checked BEFORE migrating, when that is possible (CHUNK_7
  //    ordering fix, closing a gap deferred from CHUNK_4_IDENTITY). When install.json could not
  //    supply an identity (absent, or tolerated-away as corrupt above) but a cluster already
  //    exists, the identity is recovered from `local_install` instead of minting a fresh one.
  //    That recovery must fail closed exactly like the file-read path above: a different
  //    account's row must never be adopted as this account's.
  //
  //    The genuine constraint: `local_install` was introduced by migration
  //    014_local_install.sql, so it does not exist on a cluster whose schema has never reached
  //    that point — querying it any earlier is not "checking early", it is a query against a
  //    table that is not there yet. There is no way to check an identity that the schema has
  //    not yet been given anywhere to store.
  //
  //    So: ask first whether the table already exists (a read-only catalog lookup, valid at any
  //    schema version). If it does — true for any cluster that has ever completed migration 014,
  //    which covers every backup restore or filesystem copy of a previously-working install,
  //    the exact case CHUNK_7's backup/restore work is about to exercise repeatedly — the
  //    mismatch is caught here, before `migrate()` touches this cluster at all. Only a cluster
  //    that both predates migration 014 AND lost its install.json falls through to the
  //    post-migration fallback check below; for that narrow case, checking pre-migration is not
  //    achievable, because the table the check depends on is created BY that migration.
  let recovered: RecordedInstall | null = null;
  let recoveredCheckedBeforeMigrate = false;
  const fetchRecorded = opts.fetchRecordedInstall ?? defaultFetchRecordedInstall;
  if (existing === null && clusterExists) {
    const tableExists = opts.recordedInstallTableExists
      ? await opts.recordedInstallTableExists(connectionString)
      : await defaultRecordedInstallTableExists(connectionString);
    if (tableExists) {
      recovered = await fetchRecorded(connectionString);
      if (recovered !== null && recovered.osAccountId !== opts.osAccountId) {
        throw new OsAccountMismatch();
      }
      recoveredCheckedBeforeMigrate = true;
    }
  }

  // 6. Migrations. The runner already wraps each file in a transaction, so a failure leaves
  //    the previous schema version usable rather than half-applied.
  const migrate = opts.migrate ?? migrateUp;
  let appliedMigrations: string[];
  try {
    appliedMigrations = await migrate(connectionString);
  } catch {
    // The underlying message can carry SQL text; the caller renders plain language instead.
    throw new PostgresStartFailed('the database could not be prepared');
  }

  // 7. Identity, recovered path fallback. Reached only when `local_install` did not exist
  //    before the migrations above ran — a cluster older than migration 014 with no
  //    install.json. The table now exists (having just been created), so the identity it
  //    records can finally be checked; a mismatch here is caught before install.json is
  //    written, even though it could not be caught before the migration itself.
  if (existing === null && clusterExists && !recoveredCheckedBeforeMigrate) {
    recovered = await fetchRecorded(connectionString);
    if (recovered !== null && recovered.osAccountId !== opts.osAccountId) {
      throw new OsAccountMismatch();
    }
  }

  mkdirSync(opts.logDir, { recursive: true });
  const install: InstallFile = {
    installId: existing?.installId ?? recovered?.installId ?? randomUUID(),
    osAccountId: opts.osAccountId,
    platform: opts.platform,
    appVersion: opts.appVersion,
    dbPort: port,
    dataDir: opts.dataDir,
    logDir: opts.logDir,
  };

  const record = opts.recordInstallRow ?? defaultRecordInstallRow;
  await record(connectionString, install);

  // 8. Last, and atomically: the file the next launch will trust.
  writeInstallFile(opts.installFilePath, install);

  return {
    port,
    connectionString,
    postgres,
    install,
    appliedMigrations,
    initialised: !clusterExists,
  };
}
