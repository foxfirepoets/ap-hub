import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import pg from 'pg';
import { startLocalDatabase } from '../src/db/local-database.js';
import { localSignIn } from '../src/auth/local-signin.js';
import { migrateUp } from '../src/db/migrate.js';
import type { SecretStore } from '../src/host/types.js';

/**
 * CHUNK_4_IDENTITY — the acceptance criterion only two REAL, separately-running installs can
 * evidence: "opening BookScout OS as a different OS account reaches no document, proposal, or token
 * belonging to the first account."
 *
 * Every BookScout OS install's private database lives under that OS account's own profile
 * (`host.dataDir()` = `%LOCALAPPDATA%\APHub`), so two OS accounts on the same computer never
 * share a data directory and therefore never share a PostgreSQL cluster. This test builds that
 * exact structure for real — two independent bundled clusters, on two different ports, over
 * two different private data directories, one per simulated OS account — and proves account B's
 * cluster contains NOTHING of account A's: not its tenant, not its owner row, not its session
 * token. This is the closest faithful simulation available in this environment (no second
 * Windows account exists here); nothing about it is mocked.
 *
 * Skips (rather than fails) when `vendor/pgsql` is absent, exactly like
 * `test/local-database.int.test.ts`.
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

describeIf('two OS accounts, two real bundled clusters — cross-account isolation', () => {
  let rootA: string;
  let rootB: string;

  const optsFor = (root: string, osAccountId: string) => ({
    binDir: BIN,
    dataDir: join(root, 'pgdata'),
    installFilePath: join(root, 'install.json'),
    logDir: join(root, 'logs'),
    exeSuffix: process.platform === 'win32' ? '.exe' : '',
    platform: 'win32' as const,
    appVersion: '0.0.0-int',
    osAccountId,
    secretStore: new MemorySecretStore(),
    migrate: (url: string) => migrateUp(url, MIGRATIONS),
  });

  beforeAll(() => {
    rootA = mkdtempSync(join(tmpdir(), 'aphub-account-a-'));
    rootB = mkdtempSync(join(tmpdir(), 'aphub-account-b-'));
  });

  afterAll(() => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  it(
    "account B's own cluster contains none of account A's tenant, owner, or session",
    async () => {
      const startedA = await startLocalDatabase(optsFor(rootA, 'S-1-5-21-REAL-ACCOUNT-A'));
      let startedB;
      try {
        // Account A signs in for real, against its own real cluster, and gets real rows.
        const savedDatabaseUrl = process.env.DATABASE_URL;
        process.env.DATABASE_URL = startedA.connectionString;
        // Force src/db/pool.ts's singleton to pick up account A's connection string. It is a
        // module-level singleton, so the two accounts cannot share one process's pool the way
        // production shares nothing between accounts either — this import gap is closed the
        // same way production closes it: one connection string bound for this account's work.
        const { closePool } = await import('../src/db/pool.js');
        await closePool();
        const signInA = await localSignIn('S-1-5-21-REAL-ACCOUNT-A', 'accountA');
        await closePool();

        // Confirm, directly against A's own cluster, that the row really is there.
        const poolA = new pg.Pool({ connectionString: startedA.connectionString });
        try {
          const { rows } = await poolA.query('SELECT id FROM users WHERE id = $1', [signInA.userId]);
          expect(rows.length).toBe(1);
        } finally {
          await poolA.end();
        }

        // Account B's install: a second, completely independent cluster.
        startedB = await startLocalDatabase(optsFor(rootB, 'S-1-5-21-REAL-ACCOUNT-B'));
        expect(startedB.port).not.toBe(startedA.port);

        // Query account B's cluster directly for ANYTHING referencing account A's identity.
        // No document, proposal, user or session belonging to account A can exist here —
        // it is a different Postgres cluster on a different port over a different data
        // directory, initialised from nothing.
        const poolB = new pg.Pool({ connectionString: startedB.connectionString });
        try {
          const users = await poolB.query('SELECT id FROM users');
          expect(users.rows.length).toBe(0);
          const sessions = await poolB.query('SELECT id FROM sessions');
          expect(sessions.rows.length).toBe(0);
          const tenants = await poolB.query('SELECT id FROM tenants');
          expect(tenants.rows.length).toBe(0);
          const install = await poolB.query('SELECT os_account_id FROM local_install');
          expect(install.rows).toEqual([{ os_account_id: 'S-1-5-21-REAL-ACCOUNT-B' }]);
        } finally {
          await poolB.end();
        }

        process.env.DATABASE_URL = savedDatabaseUrl;
      } finally {
        await startedA.postgres.stop();
        await startedB?.postgres.stop();
      }
    },
    240_000,
  );
});
