import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import type { SecretStore, SupportedPlatform } from '../host/types.js';
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
  recordInstallRow?: (connectionString: string, row: InstallFile) => Promise<void>;
  /** Recover an identity from the `local_install` row when install.json could not be read. */
  fetchRecordedInstall?: (connectionString: string) => Promise<RecordedInstall | null>;
}

/** The slice of the `local_install` row CHUNK_4's corrupted-file recovery needs. */
export interface RecordedInstall {
  installId: string;
  osAccountId: string;
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

  // 4. The application database. `initdb` creates only postgres/template0/template1.
  const adminUrl = buildConnectionString({
    user: postgres.user,
    password,
    port,
    database: 'postgres',
  });
  const createDb = opts.createDatabaseIfMissing ?? defaultCreateDatabase;
  await createDb(adminUrl, postgres.database);

  const connectionString = postgres.connectionString(password);

  // 5. Migrations. The runner already wraps each file in a transaction, so a failure leaves
  //    the previous schema version usable rather than half-applied.
  const migrate = opts.migrate ?? migrateUp;
  let appliedMigrations: string[];
  try {
    appliedMigrations = await migrate(connectionString);
  } catch {
    // The underlying message can carry SQL text; the caller renders plain language instead.
    throw new PostgresStartFailed('the database could not be prepared');
  }

  // 6. Identity. Reuse the recorded install id so the install keeps one identity for life.
  //    When install.json could not supply one (absent, or tolerated-away as corrupt above) but
  //    a cluster already exists, recover it from the database instead of minting a fresh one —
  //    "regenerated from the database and the OS account", not from nothing. A recovered
  //    identity is fail-closed the same way a file-supplied one is: a different account's row
  //    must never be adopted as this account's.
  let recovered: RecordedInstall | null = null;
  if (existing === null && clusterExists) {
    const fetchRecorded = opts.fetchRecordedInstall ?? defaultFetchRecordedInstall;
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

  // 7. Last, and atomically: the file the next launch will trust.
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
