import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * CHUNK_7_BACKUP — shelling out to the bundled `pg_dump` / `pg_restore` / `createdb` /
 * `dropdb` without ever putting the database password on the command line or in a
 * persistent environment variable.
 *
 * `src/db/postgres-runtime.ts` already established the pattern this follows: `initdb`'s
 * password goes through a short-lived 0600 file, never argv, never env, deleted immediately
 * after use. These four client tools have no `--pwfile` equivalent, but libpq's own supported
 * mechanism for the same problem is a `.pgpass` file referenced by the `PGPASSFILE` env var —
 * the env var carries only a temp file PATH, never the secret itself.
 *
 * Critically, the file must NOT live in `os.tmpdir()`: on Windows/NTFS, Node's `{ mode: 0o600 }`
 * has no ACL effect, so a tmpdir-resident pgpass file is readable by anything else running as
 * the same user session — not actually restricted. `postgres-runtime.ts`'s `initdb` pwfile
 * avoids this by sitting beside the data root, which `desktop/database.ts` ACL-hardens via
 * `host.fsPermissions.restrictToCurrentUser(dataRoot)` before use. This module follows the same
 * real pattern: the caller supplies a directory (under its own secured backup/data root) plus
 * the `restrictToCurrentUser` primitive, and this module hardens that directory immediately
 * before writing the secret into it — never trusting the mode bit alone.
 */

export interface PgConnection {
  host: string;
  port: number;
  user: string;
  password: string;
}

/**
 * Where the short-lived `.pgpass` file is written, and the primitive that ACL-hardens it.
 * `dir` should be a subdirectory of a location the caller already controls (e.g. the backup
 * directory); `restrictToCurrentUser` is the same `FsPermissions` method
 * `desktop/database.ts` calls on the Postgres data root — it creates `dir` if absent.
 */
export interface SecurePgPassDir {
  dir: string;
  restrictToCurrentUser: (dir: string) => Promise<void>;
}

export class PgToolFailed extends Error {
  readonly code = 'BACKUP_FAILED';
  readonly detail?: string;
  constructor(tool: string, detail?: string) {
    super(`${tool} failed`);
    this.name = 'PgToolFailed';
    this.detail = detail;
  }
}

/** Escape a `.pgpass` field per its colon/backslash escaping rule. */
function escapePgPassField(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

async function withPgPassFile<T>(
  conn: PgConnection,
  secureDir: SecurePgPassDir,
  fn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const line =
    [conn.host, String(conn.port), '*', conn.user, conn.password].map(escapePgPassField).join(':') + '\n';
  // Harden the directory BEFORE the secret is written into it — not after, and not instead of.
  await secureDir.restrictToCurrentUser(secureDir.dir);
  const pgpassPath = join(secureDir.dir, `.aphub-pgpass-${randomBytes(8).toString('hex')}`);
  await writeFile(pgpassPath, line, { encoding: 'utf8', mode: 0o600 });
  try {
    return await fn({ ...process.env, PGPASSFILE: pgpassPath });
  } finally {
    await rm(pgpassPath, { force: true });
  }
}

/** Run one bundled PostgreSQL client tool against `conn`, with `-h/-p/-U` filled in. */
export async function runPgTool(
  bin: (name: string) => string,
  tool: string,
  args: string[],
  conn: PgConnection,
  secureDir: SecurePgPassDir,
  timeoutMs = 300_000,
): Promise<void> {
  await withPgPassFile(conn, secureDir, (env) => {
    return new Promise<void>((resolve, reject) => {
      execFile(
        bin(tool),
        ['-h', conn.host, '-p', String(conn.port), '-U', conn.user, ...args],
        { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new PgToolFailed(tool, String(stderr).trim() || undefined));
            return;
          }
          resolve();
        },
      );
    });
  });
}
