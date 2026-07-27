import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
 * the env var carries only a temp file PATH, never the secret itself, and the file is written
 * 0600 and removed in a `finally` immediately after each single command completes.
 */

export interface PgConnection {
  host: string;
  port: number;
  user: string;
  password: string;
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

async function withPgPassFile<T>(conn: PgConnection, fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const line =
    [conn.host, String(conn.port), '*', conn.user, conn.password].map(escapePgPassField).join(':') + '\n';
  const pgpassPath = join(tmpdir(), `.aphub-pgpass-${randomBytes(8).toString('hex')}`);
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
  timeoutMs = 300_000,
): Promise<void> {
  await withPgPassFile(conn, (env) => {
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
