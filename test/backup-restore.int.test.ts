import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startLocalDatabase } from '../src/db/local-database';
import { migrateUp } from '../src/db/migrate';
import type { SecretStore } from '../src/host/types';
import { createWindowsHostAdapter } from '../src/host/windows';
import { buildConnectionString } from '../src/db/postgres-runtime';
import { createBackup } from '../src/backup/create';
import {
  restoreBackup,
  RestoreFailed,
  renameDatabaseWithRetry,
  restoreSwapMarkerPath,
  type RestoreSwapMarker,
} from '../src/backup/restore';
import { BACKUP_TABLES } from '../src/backup/manifest';

/**
 * CHUNK_7_BACKUP — the destroy-and-restore drill, the P0 proof the whole chunk exists for.
 *
 * Uses its own private bundled cluster on a probed port (same pattern as
 * `test/backup-create.int.test.ts`), never the shared `DATABASE_URL` test instance, both so it
 * never contends with another agent's suite and because this test genuinely renames and
 * replaces the live database — not something to ever risk against a shared fixture.
 *
 * Skips (rather than fails) when `vendor/pgsql` is absent — see that file for why.
 */

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

// The real Windows `restrictToCurrentUser` primitive (icacls), not a stub — same as
// `backup-create.int.test.ts`.
const windowsHost = createWindowsHostAdapter();

interface Snapshot {
  messages: Record<string, unknown>[];
  attachments: Record<string, unknown>[];
  attachment_blobs: Record<string, unknown>[];
  proposals: Record<string, unknown>[];
  postings: Record<string, unknown>[];
  audit_log: Record<string, unknown>[];
  exceptions: Record<string, unknown>[];
}

/** `attachment_blobs` is keyed by `sha256` (no `id` column); every other table here has one. */
async function rowsOf(pool: pg.Pool, table: string, orderBy: string): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
  return rows.map((row: Record<string, unknown>) => {
    const bytes = row.bytes;
    // bytea comes back as a Buffer; hex-encode so two snapshots taken from different Pool
    // instances compare by value rather than by object identity quirks.
    return bytes ? { ...row, bytes: Buffer.from(bytes as Buffer).toString('hex') } : row;
  });
}

/** Full-content snapshot of every table the backup/restore path is responsible for, plus
 *  `audit_log` and `exceptions` — used to prove an EXACT match, not just matching counts. */
async function captureSnapshot(pool: pg.Pool): Promise<Snapshot> {
  return {
    messages: await rowsOf(pool, 'messages', 'id'),
    attachments: await rowsOf(pool, 'attachments', 'id'),
    attachment_blobs: await rowsOf(pool, 'attachment_blobs', 'sha256'),
    proposals: await rowsOf(pool, 'proposals', 'id'),
    // `postings` is an auto-updatable view over the real table `postings_ap` (migration 006);
    // SELECT works on the view fine, and this is what `manifest.ts`'s BACKUP_TABLES reads too.
    postings: await rowsOf(pool, 'postings', 'id'),
    audit_log: await rowsOf(pool, 'audit_log', 'id'),
    exceptions: await rowsOf(pool, 'exceptions', 'id'),
  };
}

/** Real TRUNCATE against the real running database — genuine destruction, not a mock.
 *  `postings_ap` is the base table; truncating the `postings` view directly is rejected by
 *  Postgres (views cannot be truncated), which is why `test/helpers.ts`'s `resetTables` also
 *  names the base table. */
async function destroyLiveData(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE messages, attachments, attachment_blobs, proposals, postings_ap, audit_log, exceptions, tenants
     RESTART IDENTITY CASCADE`,
  );
}

async function seedRepresentativeData(
  pool: pg.Pool,
  opts: { tenantName: string; gmailId: string; sha: string; idem: string },
): Promise<void> {
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [opts.tenantName],
  );
  const tenantId = rows[0]!.id;
  const msg = await pool.query<{ id: number }>(
    `INSERT INTO messages (tenant_id, gmail_message_id, subject, from_addr) VALUES ($1,$2,$3,$4) RETURNING id`,
    [tenantId, opts.gmailId, 'Invoice from Acme', 'billing@acme.com'],
  );
  const messageId = msg.rows[0]!.id;
  await pool.query(
    `INSERT INTO attachment_blobs (sha256, bytes, mime, size) VALUES ($1,$2,'application/pdf',5)`,
    [opts.sha, Buffer.from([1, 2, 3, 4, 5])],
  );
  await pool.query(
    `INSERT INTO attachments (tenant_id, message_id, filename, sha256, size) VALUES ($1,$2,'invoice.pdf',$3,5)`,
    [tenantId, messageId, opts.sha],
  );
  await pool.query(
    `INSERT INTO proposals (tenant_id, proposed_txn) VALUES ($1, '{}'::jsonb)`,
    [tenantId],
  );
  await pool.query(
    `INSERT INTO postings (tenant_id, idempotency_key) VALUES ($1,$2)`,
    [tenantId, opts.idem],
  );
  await pool.query(
    `INSERT INTO audit_log (tenant_id, actor, action, entity) VALUES ($1,'test-actor','seed','messages')`,
    [tenantId],
  );
  await pool.query(
    `INSERT INTO exceptions (tenant_id, reason_code, detail) VALUES ($1,'TEST_REASON','seed exception')`,
    [tenantId],
  );
}

describeIf('restoreBackup — destroy-and-restore drill, real bundled PostgreSQL', () => {
  let root: string;
  let secretStore: MemorySecretStore;
  let connection: { host: string; port: number; user: string; password: string; database: string };
  let connectionString: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'aphub-restore-int-'));
    secretStore = new MemorySecretStore();

    const started = await startLocalDatabase({
      binDir: BIN,
      dataDir: join(root, 'pgdata'),
      installFilePath: join(root, 'install.json'),
      logDir: join(root, 'logs'),
      exeSuffix: EXE,
      platform: 'win32',
      appVersion: '0.0.0-restore-int',
      osAccountId: 'S-1-5-21-restore-int',
      secretStore,
      migrate: (url: string) => migrateUp(url, MIGRATIONS),
    });
    stop = () => started.postgres.stop();
    connectionString = started.connectionString;

    connection = {
      host: '127.0.0.1',
      port: started.port,
      user: started.postgres.user,
      password: readPassword(secretStore),
      database: started.postgres.database,
    };
  }, 180_000);

  afterAll(async () => {
    await stop?.();
    rmSync(root, { recursive: true, force: true });
  });

  function readPassword(store: MemorySecretStore): string {
    const value = store.values.get('APHub/database/superuser');
    if (!value) throw new Error('test setup: database password missing from secret store');
    return value;
  }

  it('backs up, genuinely destroys the live data, restores, and matches the pre-destruction state exactly', async () => {
    const seedPool = new pg.Pool({ connectionString });
    // The restore below terminates every other connection to the live database, including
    // this pool's idle client — without this handler that surfaces as an unhandled 'error'
    // event on the Pool and crashes the test process, not a real backup/restore failure.
    seedPool.on('error', () => {});

    await destroyLiveData(seedPool); // start from a clean slate for this test
    await seedRepresentativeData(seedPool, {
      tenantName: 'Drill Co',
      gmailId: 'gm-drill-1',
      sha: 'sha-drill-1',
      idem: 'idem-drill-1',
    });

    const before = await captureSnapshot(seedPool);
    expect(before.messages.length).toBe(1);
    expect(before.attachments.length).toBe(1);
    expect(before.attachment_blobs.length).toBe(1);
    expect(before.proposals.length).toBe(1);
    expect(before.postings.length).toBe(1);
    expect(before.audit_log.length).toBe(1);
    expect(before.exceptions.length).toBe(1);

    const backupResult = await createBackup({
      kind: 'manual',
      connection,
      pgBinDir: BIN,
      exeSuffix: EXE,
      backupDir: join(root, 'backups-drill'),
      restrictToCurrentUser: windowsHost.fsPermissions.restrictToCurrentUser,
      secretStore,
    });
    expect(backupResult.verified).toBe(true);

    // Genuinely destroy the data: a real TRUNCATE against the real running database, not a
    // restore into a database that still has the old rows sitting there.
    await destroyLiveData(seedPool);
    const destroyed = await captureSnapshot(seedPool);
    expect(destroyed.messages.length).toBe(0);
    expect(destroyed.attachments.length).toBe(0);
    expect(destroyed.attachment_blobs.length).toBe(0);
    expect(destroyed.proposals.length).toBe(0);
    expect(destroyed.postings.length).toBe(0);
    expect(destroyed.audit_log.length).toBe(0);
    expect(destroyed.exceptions.length).toBe(0);

    await seedPool.end();

    const restoreResult = await restoreBackup({
      backupId: backupResult.backupId,
      connection,
      pgBinDir: BIN,
      exeSuffix: EXE,
      backupDir: join(root, 'restore-drill'),
      dataDir: join(root, 'pgdata'),
      restrictToCurrentUser: windowsHost.fsPermissions.restrictToCurrentUser,
      secretStore,
    });
    expect(restoreResult.restored).toBe(true);
    for (const table of BACKUP_TABLES) {
      expect(restoreResult.rowCounts[table]).toBe(backupResult.rowCounts[table]);
    }

    const restoredPool = new pg.Pool({ connectionString });
    try {
      const after = await captureSnapshot(restoredPool);
      // The exact match the drill exists to prove: document counts, audit rows and postings
      // are not merely present, they are byte-for-byte the pre-destruction snapshot.
      expect(after).toEqual(before);
    } finally {
      await restoredPool.end();
    }
  }, 180_000);

  it('refuses to restore from a tampered backup, and never touches the live database', async () => {
    const seedPool = new pg.Pool({ connectionString });
    seedPool.on('error', () => {});

    await seedRepresentativeData(seedPool, {
      tenantName: 'Tamper Co',
      gmailId: 'gm-tamper-1',
      sha: 'sha-tamper-1',
      idem: 'idem-tamper-1',
    });

    const created = await createBackup({
      kind: 'manual',
      connection,
      pgBinDir: BIN,
      exeSuffix: EXE,
      backupDir: join(root, 'backups-tamper-restore'),
      restrictToCurrentUser: windowsHost.fsPermissions.restrictToCurrentUser,
      secretStore,
    });
    expect(created.verified).toBe(true);

    // Flip a byte well past the header, inside the ciphertext — the same tamper technique
    // `backup-create.int.test.ts` uses to prove `verify.ts` catches corruption. GCM
    // authentication (crypto.ts) is what actually catches this; `restoreBackup` must hit that
    // check before it creates, drops or renames a single database.
    const bytes = readFileSync(created.path);
    const tamperOffset = Math.min(bytes.length - 1, 200);
    bytes[tamperOffset] = bytes[tamperOffset]! ^ 0xff;
    writeFileSync(created.path, bytes);

    const before = await captureSnapshot(seedPool);

    await expect(
      restoreBackup({
        backupId: created.backupId,
        connection,
        pgBinDir: BIN,
        exeSuffix: EXE,
        backupDir: join(root, 'restore-tamper'),
        dataDir: join(root, 'pgdata'),
        restrictToCurrentUser: windowsHost.fsPermissions.restrictToCurrentUser,
        secretStore,
      }),
    ).rejects.toThrow(RestoreFailed);

    // The live database was never touched: same connection, same pool, still the same rows.
    const after = await captureSnapshot(seedPool);
    expect(after).toEqual(before);

    await seedPool.end();
  }, 180_000);

  it(
    'recovers automatically from a crash between the two rename-swap steps, instead of ' +
      'silently creating an empty database on the next launch',
    async () => {
      const seedPool = new pg.Pool({ connectionString });
      seedPool.on('error', () => {});

      await destroyLiveData(seedPool);
      await seedRepresentativeData(seedPool, {
        tenantName: 'Crash Co',
        gmailId: 'gm-crash-1',
        sha: 'sha-crash-1',
        idem: 'idem-crash-1',
      });
      const beforeCrash = await captureSnapshot(seedPool);
      expect(beforeCrash.messages.length).toBe(1);
      await seedPool.end();

      const liveDb = connection.database;
      const retiredDb = `${liveDb}_pre_restore_crashtest001`;
      const dataDir = join(root, 'pgdata');
      const adminConnStr = buildConnectionString({
        user: connection.user,
        password: connection.password,
        port: connection.port,
        database: 'postgres',
      });

      // Genuinely perform step 1 of the real rename-swap, using the exact same production
      // function `restoreBackup` itself calls — then stop, exactly as if the process had been
      // hard-killed right after this rename and before the second one. This is not a mock: the
      // live database is really renamed aside via a real `ALTER DATABASE ... RENAME`.
      const preCrashAdminPool = new pg.Pool({ connectionString: adminConnStr });
      try {
        await renameDatabaseWithRetry(preCrashAdminPool, liveDb, retiredDb);
      } finally {
        await preCrashAdminPool.end();
      }

      // Write the marker in the exact shape `restoreBackup` writes it before the swap begins,
      // naming the retired database the "crash" left orphaned. `stagingDb` is never created in
      // this drill — recovery never needs to read it, only `liveDb`/`retiredDb`.
      const marker: RestoreSwapMarker = {
        liveDb,
        retiredDb,
        stagingDb: 'aphub_restore_crashtest001',
        startedAt: new Date().toISOString(),
      };
      writeFileSync(restoreSwapMarkerPath(dataDir), JSON.stringify(marker));

      // Prove the live database genuinely does not exist right now — the exact silent-data-loss
      // trigger condition `defaultCreateDatabase` would otherwise walk straight into.
      const missingCheckPool = new pg.Pool({ connectionString: adminConnStr });
      try {
        const { rowCount } = await missingCheckPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [liveDb]);
        expect(rowCount).toBe(0);
      } finally {
        await missingCheckPool.end();
      }

      // The machine "dies": the server that performed the rename above stops.
      await stop();

      // The next launch — a fresh boot against the same data directory, the actual production
      // entry point — must recover automatically instead of manufacturing an empty database.
      const recovered = await startLocalDatabase({
        binDir: BIN,
        dataDir,
        installFilePath: join(root, 'install.json'),
        logDir: join(root, 'logs'),
        exeSuffix: EXE,
        platform: 'win32',
        appVersion: '0.0.0-restore-int',
        osAccountId: 'S-1-5-21-restore-int',
        secretStore,
        migrate: (url: string) => migrateUp(url, MIGRATIONS),
      });
      stop = () => recovered.postgres.stop(); // afterAll cleans up this instance instead now

      expect(existsSync(restoreSwapMarkerPath(dataDir))).toBe(false);

      const restoredPool = new pg.Pool({ connectionString: recovered.connectionString });
      try {
        const after = await captureSnapshot(restoredPool);
        // The pre-crash (pre-restore) data — not an empty freshly-created database.
        expect(after).toEqual(beforeCrash);
      } finally {
        await restoredPool.end();
      }

      const postRecoveryAdminPool = new pg.Pool({
        connectionString: buildConnectionString({
          user: connection.user,
          password: connection.password,
          port: recovered.port,
          database: 'postgres',
        }),
      });
      try {
        const { rowCount: retiredStillThere } = await postRecoveryAdminPool.query(
          'SELECT 1 FROM pg_database WHERE datname = $1',
          [retiredDb],
        );
        expect(retiredStillThere).toBe(0); // renamed back to the live name, not left orphaned
      } finally {
        await postRecoveryAdminPool.end();
      }
    },
    180_000,
  );
});
