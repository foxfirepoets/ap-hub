import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startLocalDatabase,
  readInstallFile,
  OsAccountMismatch,
  DATABASE_PASSWORD_TARGET,
  type LocalPostgres,
} from '../src/db/local-database.js';
import { requireSession } from '../src/auth/guard.js';
import { scopedQuery } from '../src/db/scoped.js';
import { localSignIn, LocalSignInDisabled } from '../src/auth/local-signin.js';
import { query } from '../src/db/pool.js';
import { resetTables, closeAll } from './helpers.js';
import type { SecretStore } from '../src/host/types.js';

/**
 * CHUNK_4_IDENTITY.
 *
 * Three things this file proves, none of them by code review alone:
 *
 *  1. A corrupted or truncated install.json never crashes a launch — the identity is
 *     recovered from the database (or minted fresh) instead. `test/local-database.test.ts`
 *     is not touched (guardrails): the tolerance is proved fresh here, against `startLocalDatabase`
 *     itself, with a harness independent of that file's.
 *  2. An install.json (or a database row recovered in its place) naming a different OS account
 *     than the one currently running fails CLOSED — `OsAccountMismatch`, never a silent adopt.
 *  3. Local sign-in — the new product entry point — creates one tenant/owner per OS account,
 *     reuses it on later launches, refuses a disabled owner, and a session it mints for one OS
 *     account cannot read a tenant scoped to a different one (`scopedQuery` denies it, exactly
 *     as it would for any other cross-tenant attempt).
 */

class FakeSecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  async put(target: string, secret: string): Promise<void> {
    this.values.set(target, secret);
  }
  async get(target: string): Promise<string | null> {
    return this.values.get(target) ?? null;
  }
  async delete(target: string): Promise<void> {
    this.values.delete(target);
  }
}

/** A no-op stand-in for the bundled runtime — these tests are about install.json, not Postgres. */
class FakePostgres implements LocalPostgres {
  readonly user = 'aphub';
  readonly database = 'aphub';
  async initialise(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  connectionString(password: string): string {
    return `postgres://aphub:${password}@127.0.0.1:55432/aphub`;
  }
}

let root: string;

function harness(overrides: Record<string, unknown> = {}) {
  const secretStore = new FakeSecretStore();
  const recorded: unknown[] = [];
  return {
    secretStore,
    recorded,
    opts: {
      binDir: join(root, 'bin'),
      dataDir: join(root, 'pgdata'),
      installFilePath: join(root, 'install.json'),
      logDir: join(root, 'logs'),
      exeSuffix: '.exe',
      platform: 'win32' as const,
      appVersion: '1.0.0',
      osAccountId: 'S-1-5-21-AAAA-1001',
      secretStore,
      runtimeFactory: () => new FakePostgres(),
      probe: async () => 55432,
      portIsFree: async () => true,
      migrate: async () => ['014_local_install.sql'],
      createDatabaseIfMissing: async () => true,
      recordInstallRow: async (_url: string, row: unknown) => {
        recorded.push(row);
      },
      // Default: behave as if `local_install` is not yet on the cluster, matching every test
      // below that does not care about the pre/post-migrate ordering — they still exercise the
      // (unavoidable) post-migration fallback check. The ordering itself is proved separately.
      recordedInstallTableExists: async () => false,
      ...overrides,
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aphub-install-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
afterAll(closeAll);

describe('a corrupted install.json never crashes a launch', () => {
  it('truncated JSON is treated as absent and a fresh identity is written', async () => {
    const h = harness();
    writeFileSync(h.opts.installFilePath, '{ "installId": "not valid json');

    const started = await startLocalDatabase(h.opts);

    expect(started.install.osAccountId).toBe('S-1-5-21-AAAA-1001');
    const onDisk = readInstallFile(h.opts.installFilePath);
    expect(onDisk).not.toBeNull();
    expect(onDisk?.installId).toBe(started.install.installId);
  });

  it('a credential-shaped key on disk is discarded rather than propagated or fatal', async () => {
    const h = harness();
    writeFileSync(
      h.opts.installFilePath,
      JSON.stringify({
        installId: '3f1d9e2a-0000-4000-8000-000000000009',
        osAccountId: 'S-1-5-21-AAAA-1001',
        platform: 'win32',
        appVersion: '1.0.0',
        dbPort: 55432,
        dataDir: 'd',
        logDir: 'l',
        apiKey: 'sk_live_51H8xKzLkJ9mNpQrStUvWxYz0123456789abcdef',
      }),
    );

    const started = await startLocalDatabase(h.opts);

    const raw = readFileSync(h.opts.installFilePath, 'utf8');
    expect(raw).not.toContain('sk_live_51H8xKzLkJ9mNpQrStUvWxYz0123456789abcdef');
    expect(started.install.osAccountId).toBe('S-1-5-21-AAAA-1001');
  });

  it('a dbPort outside 1024-65535 on disk is discarded, not fatal', async () => {
    const h = harness();
    writeFileSync(
      h.opts.installFilePath,
      JSON.stringify({
        installId: '3f1d9e2a-0000-4000-8000-00000000000a',
        osAccountId: 'S-1-5-21-AAAA-1001',
        platform: 'win32',
        appVersion: '1.0.0',
        dbPort: 70000,
        dataDir: 'd',
        logDir: 'l',
      }),
    );

    const started = await startLocalDatabase(h.opts);
    expect(started.install.dbPort).toBe(55432); // re-probed, not the poisoned recorded value
  });

  it('recovers the prior install id from the database when the cluster already exists', async () => {
    const h = harness({
      fetchRecordedInstall: async () => ({
        installId: '11111111-1111-4111-8111-111111111111',
        osAccountId: 'S-1-5-21-AAAA-1001',
      }),
    });
    mkdirSync(h.opts.dataDir, { recursive: true });
    writeFileSync(join(h.opts.dataDir, 'PG_VERSION'), '16'); // cluster already exists
    writeFileSync(h.opts.installFilePath, 'not json at all');
    await h.secretStore.put(DATABASE_PASSWORD_TARGET, 'carried-over');

    const started = await startLocalDatabase(h.opts);
    expect(started.install.installId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('direct readInstallFile still throws on a bad file — the tolerance is only in startLocalDatabase', () => {
    const path = join(root, 'install.json');
    writeFileSync(path, 'not json');
    expect(() => readInstallFile(path)).toThrow();
  });
});

describe('an OS-account mismatch fails closed', () => {
  it('rejects a valid install.json recorded for a different OS account', async () => {
    const h = harness();
    writeFileSync(
      h.opts.installFilePath,
      JSON.stringify({
        installId: '22222222-2222-4222-8222-222222222222',
        osAccountId: 'S-1-5-21-SOMEONE-ELSE-9999',
        platform: 'win32',
        appVersion: '1.0.0',
        dbPort: 55432,
        dataDir: 'd',
        logDir: 'l',
      }),
    );

    await expect(startLocalDatabase(h.opts)).rejects.toBeInstanceOf(OsAccountMismatch);
    // Fails BEFORE any secret is even touched or overwritten.
    expect(h.secretStore.values.size).toBe(0);
  });

  it('rejects a database-recovered identity for a different OS account too', async () => {
    const h = harness({
      fetchRecordedInstall: async () => ({
        installId: '33333333-3333-4333-8333-333333333333',
        osAccountId: 'S-1-5-21-SOMEONE-ELSE-9999',
      }),
    });
    mkdirSync(h.opts.dataDir, { recursive: true });
    writeFileSync(join(h.opts.dataDir, 'PG_VERSION'), '16');
    // No install.json at all — forces the database-recovery path.
    await h.secretStore.put(DATABASE_PASSWORD_TARGET, 'carried-over');

    await expect(startLocalDatabase(h.opts)).rejects.toBeInstanceOf(OsAccountMismatch);
  });

  it(
    'checks a database-recovered identity BEFORE migrating, when local_install already exists ' +
      'on the cluster (CHUNK_7 ordering fix)',
    async () => {
      let migrateCalled = false;
      const h = harness({
        // Simulates a cluster that already completed migration 014 — e.g. a restored backup,
        // or a filesystem copy of another account's dataDir. This is the case the ordering fix
        // closes: the mismatch must be caught before `migrate()` touches this cluster at all.
        recordedInstallTableExists: async () => true,
        fetchRecordedInstall: async () => ({
          installId: '55555555-5555-4555-8555-555555555555',
          osAccountId: 'S-1-5-21-SOMEONE-ELSE-9999',
        }),
        migrate: async () => {
          migrateCalled = true;
          return ['014_local_install.sql'];
        },
      });
      mkdirSync(h.opts.dataDir, { recursive: true });
      writeFileSync(join(h.opts.dataDir, 'PG_VERSION'), '16');
      // No install.json — forces the database-recovery path.
      await h.secretStore.put(DATABASE_PASSWORD_TARGET, 'carried-over');

      await expect(startLocalDatabase(h.opts)).rejects.toBeInstanceOf(OsAccountMismatch);
      expect(migrateCalled).toBe(false);
    },
  );

  it(
    'still falls back to a post-migration check when local_install does not exist yet ' +
      '(a cluster older than migration 014, the one case pre-migration checking cannot reach)',
    async () => {
      const callOrder: string[] = [];
      const h = harness({
        recordedInstallTableExists: async () => {
          callOrder.push('tableExistsCheck');
          return false;
        },
        fetchRecordedInstall: async () => {
          callOrder.push('fetchRecordedInstall');
          return {
            installId: '66666666-6666-4666-8666-666666666666',
            osAccountId: 'S-1-5-21-SOMEONE-ELSE-9999',
          };
        },
        migrate: async () => {
          callOrder.push('migrate');
          return ['014_local_install.sql'];
        },
      });
      mkdirSync(h.opts.dataDir, { recursive: true });
      writeFileSync(join(h.opts.dataDir, 'PG_VERSION'), '16');
      await h.secretStore.put(DATABASE_PASSWORD_TARGET, 'carried-over');

      await expect(startLocalDatabase(h.opts)).rejects.toBeInstanceOf(OsAccountMismatch);
      // migrate necessarily ran before the identity could be fetched, because the table it
      // lives in did not exist until migrate() created it.
      expect(callOrder).toEqual(['tableExistsCheck', 'migrate', 'fetchRecordedInstall']);
    },
  );

  it('the matching account proceeds normally (control case)', async () => {
    const h = harness();
    writeFileSync(
      h.opts.installFilePath,
      JSON.stringify({
        installId: '44444444-4444-4444-8444-444444444444',
        osAccountId: 'S-1-5-21-AAAA-1001',
        platform: 'win32',
        appVersion: '1.0.0',
        dbPort: 55432,
        dataDir: 'd',
        logDir: 'l',
      }),
    );
    const started = await startLocalDatabase(h.opts);
    expect(started.install.installId).toBe('44444444-4444-4444-8444-444444444444');
  });
});

describe('local sign-in — the OS account becomes the owner', () => {
  beforeEach(resetTables);

  it('first launch for an OS account creates its own tenant and an active owner', async () => {
    const r = await localSignIn('S-1-5-21-OWNER-1', 'alex');
    expect(r.isFirstRun).toBe(true);
    expect(r.role).toBe('owner_controller');

    const ctx = await requireSession(r.session.token);
    expect(ctx.tenantId).toBe(r.tenantId);
    expect(ctx.role).toBe('owner_controller');
  });

  it('a later launch for the same OS account reuses the same tenant and owner', async () => {
    const first = await localSignIn('S-1-5-21-OWNER-2', 'alex');
    const second = await localSignIn('S-1-5-21-OWNER-2', 'alex-renamed');
    expect(second.isFirstRun).toBe(false);
    expect(second.userId).toBe(first.userId);
    expect(second.tenantId).toBe(first.tenantId);

    const { rows } = await query<{ name: string; email: string }>(
      'SELECT name, email FROM users WHERE id = $1',
      [first.userId],
    );
    // The display label is refreshed (a Windows account can be renamed) — never a fixed email.
    expect(rows[0]?.name).toBe('alex-renamed');
  });

  it('refuses a disabled owner — no session minted', async () => {
    const first = await localSignIn('S-1-5-21-OWNER-3', 'alex');
    await query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [first.userId]);
    await expect(localSignIn('S-1-5-21-OWNER-3', 'alex')).rejects.toBeInstanceOf(LocalSignInDisabled);
  });

  it('two different OS accounts get two entirely separate tenants and owners', async () => {
    const a = await localSignIn('S-1-5-21-ACCOUNT-A', 'accountA');
    const b = await localSignIn('S-1-5-21-ACCOUNT-B', 'accountB');
    expect(a.tenantId).not.toBe(b.tenantId);
    expect(a.userId).not.toBe(b.userId);
  });

  it("opening as OS account B reaches none of account A's data: a session scoped to A cannot read B's tenant, and vice versa", async () => {
    const a = await localSignIn('S-1-5-21-ISOLATION-A', 'accountA');
    const b = await localSignIn('S-1-5-21-ISOLATION-B', 'accountB');

    const ctxA = await requireSession(a.session.token);
    const ctxB = await requireSession(b.session.token);
    expect(ctxA.tenantId).toBe(a.tenantId);
    expect(ctxB.tenantId).toBe(b.tenantId);

    // The exact mechanism every tenant-scoped read goes through (src/db/scoped.ts). Querying
    // for B's own owner row, scoped by A's tenant, returns nothing — A's session reaches none
    // of B's rows, and the reverse holds too.
    const aLookingForB = await scopedQuery(ctxA.tenantId, 'SELECT id FROM users WHERE tenant_id = $1 AND id = $2', [
      b.userId,
    ]);
    expect(aLookingForB.rows.length).toBe(0);

    const bLookingForA = await scopedQuery(ctxB.tenantId, 'SELECT id FROM users WHERE tenant_id = $1 AND id = $2', [
      a.userId,
    ]);
    expect(bLookingForA.rows.length).toBe(0);

    // Each session reaches only its own owner row.
    const aOwn = await scopedQuery(ctxA.tenantId, 'SELECT id FROM users WHERE tenant_id = $1 AND id = $2', [
      a.userId,
    ]);
    expect(aOwn.rows.length).toBe(1);
  });

  it('rejects an empty OS account id rather than guessing an identity', async () => {
    await expect(localSignIn('', 'alex')).rejects.toThrow();
  });
});

describe('plain-language UI: no Google SSO, and a clear per-account privacy statement', () => {
  it('the login fallback screen names no Google sign-in and no dead end', () => {
    const src = readFileSync(join(process.cwd(), 'app', 'login', 'page.tsx'), 'utf8');
    expect(src).not.toMatch(/Sign in with Google/i);
    expect(src).not.toMatch(/\/api\/auth\/login/);
    expect(src).toMatch(/Try again/);
  });

  it('the onboarding welcome screen states the per-account privacy guarantee in plain language', () => {
    const src = readFileSync(join(process.cwd(), 'app', 'components', 'OnboardingWelcome.tsx'), 'utf8');
    const normalized = src.replace(/\s+/g, ' ');
    expect(normalized).toContain(
      "This is your own AP-Hub. It doesn&apos;t share information with other people who use this computer.",
    );
  });
});
