import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * CHUNK_7_BACKUP — the disk-full edge case the spec names explicitly ("the disk fills mid-backup
 * and surfaces `DISK_FULL` with the pause message") but which had zero test coverage: the code
 * path existed (`isDiskFullError` / the disk-full regex in `src/backup/http.ts`) but nothing
 * proved `pg_dump` actually failing with "no space" reaches it.
 *
 * `pg_dump` itself is the one call intercepted — everything else (`initdb`, `pg_ctl`, the real
 * DB connection `captureRowCounts` needs before `pg_dump` even runs) uses the REAL bundled
 * PostgreSQL, exactly like `backup-create.int.test.ts`. Only the one call this test is about is
 * faked, so the assertion is about `createBackup`'s real error handling, not a stub end to end.
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const fakeExecFile = ((file: unknown, ...rest: unknown[]) => {
    if (typeof file === 'string' && file.includes('pg_dump')) {
      const callback = rest[rest.length - 1] as (err: Error, stdout: string, stderr: string) => void;
      const err = Object.assign(new Error('Command failed: pg_dump'), { code: 1 });
      queueMicrotask(() =>
        callback(err, '', 'pg_dump: error: could not write to output file: No space left on device'),
      );
      return undefined;
    }
    return (actual.execFile as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.execFile;
  return { ...actual, execFile: fakeExecFile };
});

import { startLocalDatabase } from '../src/db/local-database';
import { migrateUp } from '../src/db/migrate';
import type { SecretStore } from '../src/host/types';
import { createWindowsHostAdapter } from '../src/host/windows';
import { createBackup, BackupCreateFailed } from '../src/backup/create';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BIN = join(ROOT, 'vendor', 'pgsql', 'bin');
const MIGRATIONS = join(ROOT, 'migrations');
const EXE = process.platform === 'win32' ? '.exe' : '';
const AVAILABLE = existsSync(join(BIN, `initdb${EXE}`));

class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  async put(t: string, s: string): Promise<void> {
    this.values.set(t, s);
  }
  async get(t: string): Promise<string | null> {
    return this.values.get(t) ?? null;
  }
  async delete(t: string): Promise<void> {
    this.values.delete(t);
  }
}

const describeIf = AVAILABLE ? describe : describe.skip;
const windowsHost = createWindowsHostAdapter();

describeIf('createBackup — disk-full mid-dump surfaces the DISK_FULL path', () => {
  let root: string;
  let secretStore: MemorySecretStore;
  let pool: pg.Pool;
  let connection: { host: string; port: number; user: string; password: string; database: string };
  let stop: () => Promise<void>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'aphub-disk-full-int-'));
    secretStore = new MemorySecretStore();

    const started = await startLocalDatabase({
      binDir: BIN,
      dataDir: join(root, 'pgdata'),
      installFilePath: join(root, 'install.json'),
      logDir: join(root, 'logs'),
      exeSuffix: EXE,
      platform: 'win32',
      appVersion: '0.0.0-disk-full-int',
      osAccountId: 'S-1-5-21-disk-full-int',
      secretStore,
      migrate: (url: string) => migrateUp(url, MIGRATIONS),
    });
    stop = () => started.postgres.stop();

    const value = secretStore.values.get('APHub/database/superuser');
    if (!value) throw new Error('test setup: database password missing from secret store');
    connection = {
      host: '127.0.0.1',
      port: started.port,
      user: started.postgres.user,
      password: value,
      database: started.postgres.database,
    };
    pool = new pg.Pool({ connectionString: started.connectionString });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await stop?.();
    rmSync(root, { recursive: true, force: true });
  });

  it('throws BackupCreateFailed carrying a disk-full-shaped detail, and writes no backup row', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM backups');
    const backupDir = join(root, 'backups-disk-full');

    let thrown: unknown;
    try {
      await createBackup({
        kind: 'manual',
        connection,
        pgBinDir: BIN,
        exeSuffix: EXE,
        backupDir,
        restrictToCurrentUser: windowsHost.fsPermissions.restrictToCurrentUser,
        secretStore,
      });
      expect.unreachable('createBackup should have thrown on a disk-full pg_dump');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BackupCreateFailed);
    const failure = thrown as BackupCreateFailed;
    expect(failure.message).toBe('the database could not be dumped');
    expect(failure.detail).toMatch(/no space/i);

    // `create.ts`'s own contract: a dump that never produced a file writes no `backups` row —
    // there is no file, size or honest manifest hash to record.
    const after = await pool.query('SELECT count(*)::int AS n FROM backups');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  }, 60_000);

  it('the failure text matches the pattern src/backup/http.ts uses to route to DISK_FULL', async () => {
    // `runCreateBackup` cannot be driven directly here without writing a REAL backup key into
    // this machine's Windows credential store as a side effect (it calls the real, uninjectable
    // `createHostAdapter()`) — the same reason `backup-ipc.test.ts` only exercises that bridge's
    // 401/403 paths. This instead proves the thing that actually matters: `createBackup`'s real
    // thrown error, on a genuine disk-full `pg_dump` failure, contains the text
    // `runCreateBackup`'s own `isDiskFullError(err) || /disk|ENOSPC|no space/i.test(...)` check
    // (`src/backup/http.ts`) looks for. Kept in sync with that pattern by hand; if the check in
    // http.ts changes, update the pattern below to match.
    const DISK_FULL_PATTERN = /disk|ENOSPC|no space/i;
    try {
      await createBackup({
        kind: 'manual',
        connection,
        pgBinDir: BIN,
        exeSuffix: EXE,
        backupDir: join(root, 'backups-disk-full-2'),
        restrictToCurrentUser: windowsHost.fsPermissions.restrictToCurrentUser,
        secretStore,
      });
      expect.unreachable('createBackup should have thrown on a disk-full pg_dump');
    } catch (err) {
      expect(err).toBeInstanceOf(BackupCreateFailed);
      const failure = err as BackupCreateFailed;
      expect(DISK_FULL_PATTERN.test(failure.message + (failure.detail ?? ''))).toBe(true);
    }
  }, 60_000);
});
