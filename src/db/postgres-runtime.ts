import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * CHUNK_2_DATABASE — the private, bundled PostgreSQL, run as a supervised child.
 *
 * The user must never install PostgreSQL, never see a port, and never have their existing
 * PostgreSQL touched. Three properties make that structural:
 *
 *   1. `listen_addresses=127.0.0.1` and a probed port from 55432 upward. The server is not
 *      reachable off the machine, and `src/db/bootstrap.ts` refuses 5432 outright.
 *   2. A private data directory the caller supplies. The runtime NEVER writes into a directory
 *      it did not itself initialise — `initialise()` refuses a non-empty directory that has no
 *      `PG_VERSION`, so it cannot adopt or corrupt somebody else's cluster.
 *   3. The superuser password is generated here and passed to `initdb` through a FILE, never on
 *      the command line and never through the environment. Both would expose it to any other
 *      process on the machine, which spec §9 forbids. The file is written inside the data
 *      directory and deleted immediately after `initdb` returns.
 *
 * OS-neutral: every path is injected, so `lint:noleak` stays green and the Windows host adapter
 * is the only thing that knows where the binaries live.
 */

export interface PostgresRuntimeOptions {
  /** Directory containing `initdb`, `pg_ctl`, `postgres`, `pg_isready`, `pg_dump`. */
  binDir: string;
  /** Private data directory. Owned exclusively by this install. */
  dataDir: string;
  /** Loopback port chosen by `probeFreePort()`. */
  port: number;
  /** Superuser role. Not a secret. */
  user?: string;
  database?: string;
  /** Executable suffix. `.exe` on Windows; injected so this module names no platform. */
  exeSuffix?: string;
  /** Seam for tests. */
  spawnImpl?: typeof spawn;
  execFileImpl?: typeof execFile;
}

export class PostgresStartFailed extends Error {
  readonly code = 'DB_FAILED';
  /**
   * Diagnostic text, kept OFF `message` on purpose. `message` is what a careless caller
   * renders; `detail` is what a log needs. Splitting them is what lets the runtime stay
   * safe to surface while still being debuggable — the first version of this class
   * discarded stderr entirely, which hid a real initialisation bug behind "initdb failed".
   */
  readonly detail?: string;
  constructor(reason: string, detail?: string) {
    super(`PostgreSQL did not start: ${reason}`);
    this.name = 'PostgresStartFailed';
    this.detail = detail;
  }
}

export class DataDirectoryNotOurs extends Error {
  readonly code = 'DB_FAILED';
  constructor(dir: string) {
    super(`Refusing to use a data directory BookScout OS did not create: ${dir}`);
    this.name = 'DataDirectoryNotOurs';
  }
}

/**
 * A password with 256 bits of entropy, URL-safe so it survives a connection string unescaped.
 * Generated per install; it lives in the OS credential store, never in `install.json` or a log.
 */
export function generateDatabasePassword(): string {
  return randomBytes(32).toString('base64url');
}

/** Build the loopback connection string. No `sslmode` — a loopback socket has no TLS to verify. */
export function buildConnectionString(o: {
  user: string;
  password: string;
  port: number;
  database: string;
}): string {
  return `postgres://${encodeURIComponent(o.user)}:${encodeURIComponent(o.password)}@127.0.0.1:${o.port}/${encodeURIComponent(o.database)}`;
}

/** True when the directory already holds a PostgreSQL cluster (has PG_VERSION). */
export function isInitialisedCluster(dataDir: string): boolean {
  return existsSync(join(dataDir, 'PG_VERSION'));
}

/**
 * Sentinel marking an initialisation this install started but has not yet finished.
 *
 * It sits BESIDE the data directory, never inside it, because `initdb` refuses a non-empty
 * target — a marker written inside would break the very operation it exists to guard.
 *
 * It is what makes interrupted initialisation recoverable without ever risking somebody
 * else's cluster. A half-written directory is only safe to delete if we can prove we were
 * the ones writing it, and the sentinel is that proof. Without it the honest response to a
 * non-empty directory with no `PG_VERSION` is to refuse, because the alternative is deleting
 * data that might not be ours.
 */
export function initSentinelPath(dataDir: string): string {
  return join(dirname(dataDir), `.aphub-initialising-${basename(dataDir)}`);
}

/** True when the directory exists and holds anything at all. */
function isNonEmptyDirectory(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * What `initialise()` should do with the directory it was handed. Exported so the decision
 * is unit-testable on its own, without touching a filesystem or spawning `initdb`.
 */
export type DataDirectoryDisposition =
  | 'ready'              // already an initialised cluster — leave it alone
  | 'fresh'              // absent or empty — initialise into it
  | 'resume-interrupted' // our own half-written attempt — clear it and initialise again
  | 'foreign';           // somebody else's data — refuse

export function classifyDataDirectory(
  dataDir: string,
  exists: { cluster: boolean; nonEmpty: boolean; sentinel: boolean },
): DataDirectoryDisposition {
  if (exists.cluster) return 'ready';
  if (!exists.nonEmpty) return 'fresh';
  return exists.sentinel ? 'resume-interrupted' : 'foreign';
}

export class PostgresRuntime {
  private readonly bin: (name: string) => string;
  private child: ChildProcess | null = null;
  readonly user: string;
  readonly database: string;

  constructor(private readonly opts: PostgresRuntimeOptions) {
    const suffix = opts.exeSuffix ?? '';
    this.bin = (name) => join(opts.binDir, `${name}${suffix}`);
    this.user = opts.user ?? 'aphub';
    this.database = opts.database ?? 'aphub';
  }

  private run(cmd: string, args: string[], timeoutMs = 120_000): Promise<string> {
    const exec = this.opts.execFileImpl ?? execFile;
    return new Promise((resolve, reject) => {
      exec(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          // Never surface raw OS text on `message` — it is carried as `detail` instead.
          reject(
            new PostgresStartFailed(`${cmd.split(/[\\/]/).pop()} failed`, String(stderr).trim() || undefined),
          );
          return;
        }
        resolve(String(stdout));
      });
    });
  }

  /** What this launch will do with the data directory, decided before anything is written. */
  disposition(): DataDirectoryDisposition {
    const dir = this.opts.dataDir;
    return classifyDataDirectory(dir, {
      cluster: isInitialisedCluster(dir),
      nonEmpty: isNonEmptyDirectory(dir),
      sentinel: existsSync(initSentinelPath(dir)),
    });
  }

  /**
   * Create the cluster if it does not exist. Idempotent: an already-initialised directory is
   * left untouched, which is what makes this safe to call on every launch.
   *
   * Refuses a non-empty directory with no `PG_VERSION` unless our own sentinel proves we were
   * the ones writing it. That is the difference between recovering from our own interrupted
   * install and deleting a user's existing cluster, and it is not a distinction to leave to
   * `initdb`'s own "directory not empty" error.
   */
  async initialise(password: string): Promise<void> {
    const dir = this.opts.dataDir;
    const sentinel = initSentinelPath(dir);

    switch (this.disposition()) {
      case 'ready':
        // A crash between `initdb` finishing and the sentinel being cleared leaves a stale
        // sentinel beside a perfectly good cluster. Clear it; do not re-initialise.
        rmSync(sentinel, { force: true });
        return;
      case 'foreign':
        throw new DataDirectoryNotOurs(dir);
      case 'resume-interrupted':
        // Our own half-written attempt. Nothing in it is data — `initdb` never got far
        // enough to accept a connection — so removing it loses nothing and unblocks retry.
        rmSync(dir, { recursive: true, force: true });
        break;
      case 'fresh':
        break;
    }

    mkdirSync(dirname(dir), { recursive: true });
    // Claim the directory BEFORE creating it, so an interruption at any point from here on
    // is recognisable as ours on the next launch.
    writeFileSync(sentinel, '', { encoding: 'utf8' });
    mkdirSync(dir, { recursive: true });

    // BESIDE the data directory, never inside it: `initdb` refuses a non-empty target, so a
    // password file written into `dir` fails initialisation outright. The parent is the
    // install's own data root, already ACL-restricted to this user.
    const pwFile = join(dirname(dir), `.aphub-initpw-${basename(dir)}`);
    try {
      // Password via file, never argv and never env — both are readable by other processes.
      writeFileSync(pwFile, password, { encoding: 'utf8', mode: 0o600 });
      await this.run(this.bin('initdb'), [
        '-D', dir,
        '-U', this.user,
        `--pwfile=${pwFile}`,
        '-E', 'UTF8',
        '--locale=C',
        '-A', 'scram-sha-256',
      ]);
    } finally {
      rmSync(pwFile, { force: true });
    }
    // Only now is the cluster real. Clearing the sentinel last is what makes the whole
    // operation atomic from the next launch's point of view.
    rmSync(sentinel, { force: true });
  }

  /** Start as a supervised child bound to loopback only. Resolves once it accepts connections. */
  async start(): Promise<void> {
    if (!isInitialisedCluster(this.opts.dataDir)) {
      throw new DataDirectoryNotOurs(this.opts.dataDir);
    }
    const spawnFn = this.opts.spawnImpl ?? spawn;
    this.child = spawnFn(
      this.bin('postgres'),
      [
        '-D', this.opts.dataDir,
        '-p', String(this.opts.port),
        '-c', 'listen_addresses=127.0.0.1',   // loopback only, never an interface
        '-c', 'logging_collector=off',
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    this.child.on('exit', () => {
      this.child = null;
    });
    await this.waitUntilReady();
  }

  /** Poll `pg_isready` until it answers or the deadline passes. */
  async waitUntilReady(timeoutMs = 60_000, intervalMs = 250): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.run(this.bin('pg_isready'), ['-h', '127.0.0.1', '-p', String(this.opts.port)], 5_000);
        return;
      } catch {
        if (Date.now() >= deadline) throw new PostgresStartFailed('timed out waiting for readiness');
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  }

  /**
   * Graceful shutdown. `-m fast` rolls back open transactions and checkpoints rather than
   * waiting for clients to disconnect (`smart`, which can hang forever) or skipping the
   * checkpoint (`immediate`, which forces crash recovery on next start).
   */
  async stop(): Promise<void> {
    try {
      await this.run(this.bin('pg_ctl'), ['-D', this.opts.dataDir, '-m', 'fast', '-w', 'stop'], 60_000);
    } finally {
      this.child = null;
    }
  }

  get running(): boolean {
    return this.child !== null;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  connectionString(password: string): string {
    return buildConnectionString({
      user: this.user,
      password,
      port: this.opts.port,
      database: this.database,
    });
  }
}
