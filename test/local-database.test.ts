import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startLocalDatabase,
  choosePort,
  readInstallFile,
  writeInstallFile,
  DatabasePasswordLost,
  RestoreSwapRecoveryFailed,
  DATABASE_PASSWORD_TARGET,
  type LocalPostgres,
  type PendingRestoreSwap,
} from '../src/db/local-database';
import {
  classifyDataDirectory,
  initSentinelPath,
  PostgresRuntime,
  DataDirectoryNotOurs,
  generateDatabasePassword,
} from '../src/db/postgres-runtime';
import type { SecretStore } from '../src/host/types';

/**
 * CHUNK_2_DATABASE — first-launch and every-launch behaviour.
 *
 * These are unit tests over the ORDERING and the REFUSALS. The real cluster is exercised
 * separately by `test/local-database.int.test.ts`, which starts the bundled server; asserting
 * the ordering here means the integration test does not have to provoke a crash mid-`initdb`
 * to prove interrupted initialisation is recoverable.
 */

class FakeSecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  readonly puts: string[] = [];
  async put(target: string, secret: string): Promise<void> {
    this.puts.push(target);
    this.values.set(target, secret);
  }
  async get(target: string): Promise<string | null> {
    return this.values.get(target) ?? null;
  }
  async delete(target: string): Promise<void> {
    this.values.delete(target);
  }
}

/** Records the order operations happen in — the property most of these tests are about. */
class FakePostgres implements LocalPostgres {
  readonly user = 'aphub';
  readonly database = 'aphub';
  constructor(
    private readonly trace: string[],
    private readonly onInitialise?: () => void,
  ) {}
  async initialise(password: string): Promise<void> {
    expect(password).not.toEqual('');
    this.trace.push('initialise');
    this.onInitialise?.();
  }
  async start(): Promise<void> {
    this.trace.push('start');
  }
  async stop(): Promise<void> {
    this.trace.push('stop');
  }
  connectionString(password: string): string {
    return `postgres://aphub:${password}@127.0.0.1:55432/aphub`;
  }
}

let root: string;

function harness(overrides: Record<string, unknown> = {}) {
  const trace: string[] = [];
  const secretStore = new FakeSecretStore();
  const recorded: unknown[] = [];
  return {
    trace,
    secretStore,
    recorded,
    opts: {
      binDir: join(root, 'bin'),
      dataDir: join(root, 'pgdata'),
      installFilePath: join(root, 'install.json'),
      logDir: join(root, 'logs'),
      exeSuffix: '.exe',
      platform: 'win32' as const,
      appVersion: '1.2.3',
      osAccountId: 'S-1-5-21-1-2-3-1001',
      secretStore,
      runtimeFactory: () => new FakePostgres(trace),
      probe: async () => 55432,
      portIsFree: async () => true,
      migrate: async () => {
        trace.push('migrate');
        return ['014_local_install.sql'];
      },
      // No real Postgres backs these tests (FakePostgres) — without this override, any test
      // that simulates an already-existing cluster would have the real crash-recovery check
      // (CHUNK_7) try a genuine network connection and fail. The ordering/behaviour of that
      // check itself is proved separately, in the "interrupted restore rename-swap" tests below.
      detectInterruptedRestoreSwap: async () => null,
      // Same reasoning for CHUNK_4_IDENTITY's recovered-identity check (also a real query when
      // a test simulates an already-existing cluster with no install.json on disk); that check's
      // own behaviour is proved separately, in test/local-install.test.ts.
      recordedInstallTableExists: async () => false,
      fetchRecordedInstall: async () => null,
      createDatabaseIfMissing: async () => {
        trace.push('createdb');
        return true;
      },
      recordInstallRow: async (_url: string, row: unknown) => {
        trace.push('record');
        recorded.push(row);
      },
      ...overrides,
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aphub-db-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('choosePort', () => {
  it('reuses the recorded port when it is still free', async () => {
    const port = await choosePort(55440, { portIsFree: async () => true, probe: async () => 55432 });
    expect(port).toBe(55440);
  });

  it('re-probes when the recorded port has been taken by something else', async () => {
    const port = await choosePort(55440, { portIsFree: async () => false, probe: async () => 55437 });
    expect(port).toBe(55437);
  });

  it('probes when nothing has been recorded yet', async () => {
    const port = await choosePort(undefined, { portIsFree: async () => true, probe: async () => 55432 });
    expect(port).toBe(55432);
  });

  it('never reuses 5432 even if a hand-edited install.json names it', async () => {
    const probed: number[] = [];
    const port = await choosePort(5432, {
      portIsFree: async () => true,
      probe: async (from) => {
        probed.push(from);
        return 55432;
      },
    });
    expect(port).toBe(55432);
    expect(probed).toEqual([55432]);
  });
});

describe('data directory disposition', () => {
  it('classifies an initialised cluster as ready', () => {
    expect(classifyDataDirectory('d', { cluster: true, nonEmpty: true, sentinel: false })).toBe('ready');
  });
  it('classifies an absent or empty directory as fresh', () => {
    expect(classifyDataDirectory('d', { cluster: false, nonEmpty: false, sentinel: false })).toBe('fresh');
  });
  it('classifies our own half-written attempt as resumable', () => {
    expect(classifyDataDirectory('d', { cluster: false, nonEmpty: true, sentinel: true })).toBe(
      'resume-interrupted',
    );
  });
  it('classifies a non-empty directory we did not create as foreign', () => {
    expect(classifyDataDirectory('d', { cluster: false, nonEmpty: true, sentinel: false })).toBe('foreign');
  });
});

describe('PostgresRuntime.initialise', () => {
  it("refuses a non-empty directory BookScout OS did not create, rather than letting initdb decide", async () => {
    const dataDir = join(root, 'someone-elses-cluster');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'important.dat'), 'a users existing data');

    const runtime = new PostgresRuntime({ binDir: join(root, 'bin'), dataDir, port: 55432 });
    await expect(runtime.initialise('pw')).rejects.toBeInstanceOf(DataDirectoryNotOurs);
    // The refusal must be non-destructive: the foreign data is still there.
    expect(existsSync(join(dataDir, 'important.dat'))).toBe(true);
  });

  it('treats a stale sentinel beside a good cluster as finished, not as a reason to re-initialise', async () => {
    const dataDir = join(root, 'pgdata');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'PG_VERSION'), '16');
    writeFileSync(initSentinelPath(dataDir), '');

    let ran = false;
    const runtime = new PostgresRuntime({
      binDir: join(root, 'bin'),
      dataDir,
      port: 55432,
      execFileImpl: ((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, s: string) => void) => {
        ran = true;
        cb(null, '');
        return undefined;
      }) as never,
    });

    await runtime.initialise('pw');
    expect(ran).toBe(false);
    expect(existsSync(initSentinelPath(dataDir))).toBe(false);
    expect(existsSync(join(dataDir, 'PG_VERSION'))).toBe(true);
  });

  it('clears our own interrupted attempt and initialises again', async () => {
    const dataDir = join(root, 'pgdata');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'partial'), 'half-written by an interrupted initdb');
    writeFileSync(initSentinelPath(dataDir), '');

    const runtime = new PostgresRuntime({
      binDir: join(root, 'bin'),
      dataDir,
      port: 55432,
      execFileImpl: ((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, s: string) => void) => {
        // Stand in for initdb: leave behind what a real one would.
        writeFileSync(join(dataDir, 'PG_VERSION'), '16');
        cb(null, '');
        return undefined;
      }) as never,
    });

    await runtime.initialise('pw');
    expect(existsSync(join(dataDir, 'partial'))).toBe(false);
    expect(existsSync(join(dataDir, 'PG_VERSION'))).toBe(true);
    expect(existsSync(initSentinelPath(dataDir))).toBe(false);
  });

  it('leaves the sentinel in place when initialisation fails, so the next launch can recover', async () => {
    const dataDir = join(root, 'pgdata');
    const runtime = new PostgresRuntime({
      binDir: join(root, 'bin'),
      dataDir,
      port: 55432,
      execFileImpl: ((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, s: string) => void) => {
        writeFileSync(join(dataDir, 'partial'), 'x');
        cb(new Error('initdb died'), '');
        return undefined;
      }) as never,
    });

    await expect(runtime.initialise('pw')).rejects.toThrow();
    expect(existsSync(initSentinelPath(dataDir))).toBe(true);
    expect(runtime.disposition()).toBe('resume-interrupted');
  });
});

describe('startLocalDatabase', () => {
  it('stores the generated password BEFORE initialising the cluster', async () => {
    const h = harness();
    // Record the store state at the moment initialise() runs.
    let secretPresentAtInit = false;
    h.opts.runtimeFactory = () =>
      new FakePostgres(h.trace, () => {
        secretPresentAtInit = h.secretStore.values.has(DATABASE_PASSWORD_TARGET);
      });

    await startLocalDatabase(h.opts);

    expect(secretPresentAtInit).toBe(true);
    expect(h.secretStore.puts).toEqual([DATABASE_PASSWORD_TARGET]);
  });

  it('runs initialise → start → create database → migrate → record, in that order', async () => {
    const h = harness();
    await startLocalDatabase(h.opts);
    expect(h.trace).toEqual(['initialise', 'start', 'createdb', 'migrate', 'record']);
  });

  it('writes install.json with the probed port and no credential-shaped field', async () => {
    const h = harness();
    const started = await startLocalDatabase(h.opts);

    const onDisk = readInstallFile(h.opts.installFilePath);
    expect(onDisk).not.toBeNull();
    expect(onDisk?.dbPort).toBe(55432);
    expect(onDisk?.appVersion).toBe('1.2.3');
    expect(onDisk?.osAccountId).toBe('S-1-5-21-1-2-3-1001');
    expect(onDisk?.installId).toBe(started.install.installId);

    // The password must not have reached the file under any key.
    const raw = readFileSync(h.opts.installFilePath, 'utf8');
    const password = h.secretStore.values.get(DATABASE_PASSWORD_TARGET) ?? 'unset';
    expect(raw).not.toContain(password);
  });

  it('records the same identity in the database row and the file', async () => {
    const h = harness();
    await startLocalDatabase(h.opts);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({
      dbPort: 55432,
      platform: 'win32',
      appVersion: '1.2.3',
    });
  });

  it('keeps the install id stable across launches', async () => {
    const first = await startLocalDatabase(harness().opts);
    // Second launch: same paths, cluster already present.
    mkdirSync(join(root, 'pgdata'), { recursive: true });
    writeFileSync(join(root, 'pgdata', 'PG_VERSION'), '16');
    const h2 = harness();
    await h2.secretStore.put(DATABASE_PASSWORD_TARGET, 'carried-over');
    const second = await startLocalDatabase(h2.opts);
    expect(second.install.installId).toBe(first.install.installId);
    expect(second.initialised).toBe(false);
  });

  it('refuses to continue when a cluster exists but its password does not', async () => {
    mkdirSync(join(root, 'pgdata'), { recursive: true });
    writeFileSync(join(root, 'pgdata', 'PG_VERSION'), '16');
    const h = harness();
    await expect(startLocalDatabase(h.opts)).rejects.toBeInstanceOf(DatabasePasswordLost);
    // Nothing was started and nothing was overwritten.
    expect(h.trace).toEqual([]);
    expect(existsSync(h.opts.installFilePath)).toBe(false);
  });

  it('surfaces a failed migration as DB_FAILED without leaking SQL, and writes no install.json', async () => {
    const h = harness({
      migrate: async () => {
        throw new Error('syntax error at or near "SELCT" — relation vendors does not exist');
      },
    });
    await expect(startLocalDatabase(h.opts)).rejects.toMatchObject({ code: 'DB_FAILED' });
    await expect(startLocalDatabase(h.opts)).rejects.not.toThrow(/SELCT/);
    expect(existsSync(h.opts.installFilePath)).toBe(false);
  });

  it('re-probes and re-records the port when the recorded one is taken on a later launch', async () => {
    const h1 = harness();
    await startLocalDatabase(h1.opts);
    expect(readInstallFile(h1.opts.installFilePath)?.dbPort).toBe(55432);

    mkdirSync(join(root, 'pgdata'), { recursive: true });
    writeFileSync(join(root, 'pgdata', 'PG_VERSION'), '16');
    const h2 = harness({ portIsFree: async () => false, probe: async () => 55439 });
    await h2.secretStore.put(DATABASE_PASSWORD_TARGET, 'carried-over');
    await startLocalDatabase(h2.opts);
    expect(readInstallFile(h2.opts.installFilePath)?.dbPort).toBe(55439);
  });
});

describe('interrupted restore rename-swap — crash recovery at boot (CHUNK_7)', () => {
  /** Fakes a cluster that already exists, so `startLocalDatabase` reaches the crash-recovery
   *  check (gated on `clusterExists`) instead of skipping it as a brand-new install. */
  function withExistingCluster(h: ReturnType<typeof harness>) {
    mkdirSync(join(root, 'pgdata'), { recursive: true });
    writeFileSync(join(root, 'pgdata', 'PG_VERSION'), '16');
    return h.secretStore.put(DATABASE_PASSWORD_TARGET, 'carried-over');
  }

  it(
    'recovers automatically before creating a database, when a pending swap is detected',
    async () => {
      const h = harness({
        detectInterruptedRestoreSwap: async () => ({ liveDb: 'aphub', retiredDb: 'aphub_pre_restore_123' }),
        recoverInterruptedRestoreSwap: async (_url: string, pending: PendingRestoreSwap) => {
          h.trace.push(`recover:${pending.retiredDb}`);
        },
      });
      await withExistingCluster(h);

      const started = await startLocalDatabase(h.opts);

      expect(started.initialised).toBe(false);
      expect(h.trace).toEqual(['initialise', 'start', 'recover:aphub_pre_restore_123', 'createdb', 'migrate', 'record']);
    },
  );

  it(
    'fails loudly instead of silently creating an empty database when recovery itself fails',
    async () => {
      const h = harness({
        detectInterruptedRestoreSwap: async () => ({ liveDb: 'aphub', retiredDb: 'aphub_pre_restore_999' }),
        recoverInterruptedRestoreSwap: async () => {
          throw new Error('rename failed: database is being accessed by other users');
        },
      });
      await withExistingCluster(h);

      await expect(startLocalDatabase(h.opts)).rejects.toBeInstanceOf(RestoreSwapRecoveryFailed);
      // The one property that matters most: no empty database was silently created.
      expect(h.trace).not.toContain('createdb');
    },
  );

  it('does nothing when no pending swap is detected — the common case on every ordinary launch', async () => {
    const h = harness({
      detectInterruptedRestoreSwap: async () => null,
    });
    await withExistingCluster(h);

    await startLocalDatabase(h.opts);
    expect(h.trace).toEqual(['initialise', 'start', 'createdb', 'migrate', 'record']);
  });

  it('is skipped entirely on a brand-new install — there is no cluster yet to have an interrupted swap', async () => {
    let detectCalled = false;
    const h = harness({
      detectInterruptedRestoreSwap: async () => {
        detectCalled = true;
        return null;
      },
    });
    // No PG_VERSION written: this is a genuinely fresh dataDir (clusterExists === false).

    await startLocalDatabase(h.opts);
    expect(detectCalled).toBe(false);
  });
});

describe('install.json durability', () => {
  it('leaves no temporary file behind after a successful write', () => {
    const path = join(root, 'install.json');
    writeInstallFile(path, {
      installId: '3f1d9e2a-0000-4000-8000-000000000001',
      osAccountId: 'S-1-5-21-9',
      platform: 'win32',
      appVersion: '1.0.0',
      dbPort: 55432,
      dataDir: join(root, 'pgdata'),
      logDir: join(root, 'logs'),
    });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('rejects an install.json that has had a secret added to it by hand', () => {
    const path = join(root, 'install.json');
    writeFileSync(
      path,
      JSON.stringify({
        installId: '3f1d9e2a-0000-4000-8000-000000000001',
        osAccountId: 'S-1-5-21-9',
        platform: 'win32',
        appVersion: '1.0.0',
        dbPort: 55432,
        dataDir: 'd',
        logDir: 'l',
        dbPassword: 'hunter2',
      }),
    );
    expect(() => readInstallFile(path)).toThrow(/credential-shaped/);
  });
});

describe('generateDatabasePassword', () => {
  it('produces distinct, URL-safe, high-entropy values', () => {
    const a = generateDatabasePassword();
    const b = generateDatabasePassword();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
