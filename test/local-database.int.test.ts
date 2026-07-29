import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import pg from 'pg';
import { startLocalDatabase, readInstallFile, DATABASE_PASSWORD_TARGET } from '../src/db/local-database';
import { isPortFree } from '../src/db/bootstrap';
import { migrateUp } from '../src/db/migrate';
import type { SecretStore } from '../src/host/types';

/**
 * CHUNK_2_DATABASE — the acceptance criteria that only a REAL server can evidence.
 *
 * Unit tests prove the ordering and the refusals. They cannot prove that the binaries we
 * ship actually start, that the probe avoids a genuinely occupied port, or that a fresh data
 * directory reaches migration head — and those are the three criteria the chunk is judged on.
 * So this file uses the bundled runtime, on a real port, against a real cluster.
 *
 * It skips (rather than fails) when `vendor/pgsql` is absent, because the 120 MB bundle is
 * not in git: run `node scripts/bundle-postgres.mjs` first. `npm run verify:live` runs it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BIN = join(ROOT, 'vendor', 'pgsql', 'bin');
const MIGRATIONS = join(ROOT, 'migrations');
const AVAILABLE = existsSync(join(BIN, 'initdb.exe')) || existsSync(join(BIN, 'initdb'));

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

describeIf('bundled PostgreSQL — real cluster', () => {
  let root: string;
  let secretStore: MemorySecretStore;

  const opts = () => ({
    binDir: BIN,
    dataDir: join(root, 'pgdata'),
    installFilePath: join(root, 'install.json'),
    logDir: join(root, 'logs'),
    exeSuffix: process.platform === 'win32' ? '.exe' : '',
    platform: 'win32' as const,
    appVersion: '0.0.0-int',
    osAccountId: 'S-1-5-21-int-test',
    secretStore,
    migrate: (url: string) => migrateUp(url, MIGRATIONS),
  });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'aphub-int-'));
    secretStore = new MemorySecretStore();
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('initialises a fresh data directory, starts, and reaches migration head', async () => {
    const started = await startLocalDatabase(opts());
    try {
      expect(started.initialised).toBe(true);
      expect(started.appliedMigrations).toContain('014_local_install.sql');
      expect(started.appliedMigrations).toContain('015_backups.sql');

      const pool = new pg.Pool({ connectionString: started.connectionString });
      try {
        // The singleton install row exists, exactly once, with the port we actually bound.
        const { rows } = await pool.query<{ n: string; db_port: number; platform: string }>(
          'SELECT count(*)::text AS n, min(db_port) AS db_port, min(platform) AS platform FROM local_install',
        );
        expect(rows[0]?.n).toBe('1');
        expect(rows[0]?.db_port).toBe(started.port);
        expect(rows[0]?.platform).toBe('win32');

        // The tables this chunk introduced are really there.
        const t = await pool.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name IN ('local_install','backups')
            ORDER BY table_name`,
        );
        expect(t.rows.map((r) => r.table_name)).toEqual(['backups', 'local_install']);
      } finally {
        await pool.end();
      }
    } finally {
      await started.postgres.stop();
    }
  }, 180_000);

  it('binds a private port at or above 55432 and never 5432', async () => {
    const started = await startLocalDatabase(opts());
    try {
      expect(started.port).toBeGreaterThanOrEqual(55432);
      expect(started.port).not.toBe(5432);
    } finally {
      await started.postgres.stop();
    }
  }, 180_000);

  it('leaves any PostgreSQL already listening on 5432 completely untouched', async () => {
    // This machine runs a system instance on 5432. The guarantee is not "we avoid the port"
    // but "we never speak to it": if BookScout OS had connected, stopped or re-initialised it, the
    // instance would not still be answering here on its own credentials.
    const occupiedBefore = !(await isPortFree(5432));
    const started = await startLocalDatabase(opts());
    try {
      expect(started.port).not.toBe(5432);
      const occupiedAfter = !(await isPortFree(5432));
      expect(occupiedAfter).toBe(occupiedBefore);
    } finally {
      await started.postgres.stop();
    }
  }, 180_000);

  it('re-opens the same cluster on a second launch without re-initialising it', async () => {
    const first = await startLocalDatabase(opts());
    const installId = first.install.installId;
    await first.postgres.stop();

    const second = await startLocalDatabase(opts());
    try {
      expect(second.initialised).toBe(false);
      // Nothing left to apply — the first launch already reached head.
      expect(second.appliedMigrations).toEqual([]);
      expect(second.install.installId).toBe(installId);
      expect(readInstallFile(opts().installFilePath)?.installId).toBe(installId);
    } finally {
      await second.postgres.stop();
    }
  }, 240_000);

  it('keeps the password out of install.json and in the credential store only', async () => {
    const started = await startLocalDatabase(opts());
    try {
      const password = secretStore.values.get(DATABASE_PASSWORD_TARGET);
      expect(password).toBeTruthy();
      const file = readInstallFile(opts().installFilePath);
      expect(JSON.stringify(file)).not.toContain(password!);
    } finally {
      await started.postgres.stop();
    }
  }, 180_000);

  it('refuses a data directory holding someone else’s files instead of overwriting them', async () => {
    const foreign = join(root, 'foreign');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'accounts.dat'), 'not ours');

    const store = new MemorySecretStore();
    await expect(
      startLocalDatabase({ ...opts(), dataDir: foreign, secretStore: store, installFilePath: join(root, 'foreign.json') }),
    ).rejects.toThrow(/did not create/);
    expect(existsSync(join(foreign, 'accounts.dat'))).toBe(true);
  }, 60_000);
});
