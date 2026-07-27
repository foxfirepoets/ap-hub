import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import pg from 'pg';
import { startLocalDatabase } from '../src/db/local-database';
import { migrateUp } from '../src/db/migrate';
import type { SecretStore } from '../src/host/types';
import { createBackup } from '../src/backup/create';
import { BACKUP_ENCRYPTION_KEY_TARGET } from '../src/backup/key';
import { verifyBackup } from '../src/backup/verify';
import { BACKUP_TABLES } from '../src/backup/manifest';

/**
 * CHUNK_7_BACKUP — proves the whole point of the chunk: a real encrypted backup, made from a
 * real running bundled PostgreSQL instance with `pg_dump`/`pg_restore`/`createdb`/`dropdb`
 * actually invoked (never mocked), decrypted back out, and restored into a scratch database
 * to confirm row counts — plus proof that a corrupted/tampered backup is caught, not silently
 * accepted.
 *
 * Uses its own private bundled cluster on a probed port (same pattern as
 * `test/local-database.int.test.ts`) rather than the shared `DATABASE_URL` test instance, so
 * it never contends with another agent's suite on the one shared database.
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

describeIf('createBackup — real bundled PostgreSQL, real pg_dump/pg_restore', () => {
  let root: string;
  let secretStore: MemorySecretStore;
  let pool: pg.Pool;
  let connection: { host: string; port: number; user: string; password: string; database: string };
  let stop: () => Promise<void>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'aphub-backup-int-'));
    secretStore = new MemorySecretStore();

    const started = await startLocalDatabase({
      binDir: BIN,
      dataDir: join(root, 'pgdata'),
      installFilePath: join(root, 'install.json'),
      logDir: join(root, 'logs'),
      exeSuffix: EXE,
      platform: 'win32',
      appVersion: '0.0.0-backup-int',
      osAccountId: 'S-1-5-21-backup-int',
      secretStore,
      migrate: (url: string) => migrateUp(url, MIGRATIONS),
    });
    stop = () => started.postgres.stop();

    connection = {
      host: '127.0.0.1',
      port: started.port,
      user: started.postgres.user,
      password: readPassword(secretStore),
      database: started.postgres.database,
    };
    pool = new pg.Pool({ connectionString: started.connectionString });

    // Seed one row in each table the backup tracks, so verification has real, checkable data.
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO tenants (name) VALUES ('Backup Test Co') RETURNING id`,
    );
    const tenantId = rows[0]!.id;
    const msg = await pool.query<{ id: number }>(
      `INSERT INTO messages (tenant_id, gmail_message_id) VALUES ($1, 'msg-1') RETURNING id`,
      [tenantId],
    );
    const messageId = msg.rows[0]!.id;
    await pool.query(
      `INSERT INTO attachment_blobs (sha256, bytes, mime, size) VALUES ('deadbeef', '\\x0102030405'::bytea, 'application/pdf', 5)`,
    );
    await pool.query(
      `INSERT INTO attachments (tenant_id, message_id, filename, sha256, size) VALUES ($1, $2, 'invoice.pdf', 'deadbeef', 5)`,
      [tenantId, messageId],
    );
    await pool.query(
      `INSERT INTO proposals (tenant_id, proposed_txn) VALUES ($1, '{}'::jsonb)`,
      [tenantId],
    );
    await pool.query(
      `INSERT INTO postings (tenant_id, idempotency_key) VALUES ($1, 'idem-1')`,
      [tenantId],
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await stop?.();
    rmSync(root, { recursive: true, force: true });
  });

  function readPassword(store: MemorySecretStore): string {
    // The database superuser password target, mirroring local-database.ts's own constant —
    // read directly here rather than importing it, to keep this test's seam small.
    const value = store.values.get('APHub/database/superuser');
    if (!value) throw new Error('test setup: database password missing from secret store');
    return value;
  }

  it('produces a verified, encrypted backup with matching row counts and no secret in the DB row', async () => {
    const backupDir = join(root, 'backups');
    const result = await createBackup({
      kind: 'manual',
      connection,
      pgBinDir: BIN,
      exeSuffix: EXE,
      backupDir,
      secretStore,
    });

    expect(result.verified).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(result.path)).toBe(true);
    for (const table of BACKUP_TABLES) {
      expect(result.rowCounts[table]).toBe(1);
    }

    // The `backups` table reflects a real, counted backup.
    const row = await pool.query<{
      verified_at: Date | null;
      manifest_hash: string;
      row_counts: Record<string, number>;
      size_bytes: string;
      path: string;
    }>('SELECT verified_at, manifest_hash, row_counts, size_bytes, path FROM backups WHERE id = $1', [
      result.backupId,
    ]);
    expect(row.rows[0]?.verified_at).not.toBeNull();
    expect(row.rows[0]?.manifest_hash).toBe(result.manifestHash);
    expect(row.rows[0]?.row_counts).toEqual(result.rowCounts);
    expect(Number(row.rows[0]?.size_bytes)).toBe(result.sizeBytes);

    // No secret or key material anywhere retrievable from the row itself.
    const serializedRow = JSON.stringify(row.rows[0]);
    const key = secretStore.values.get(BACKUP_ENCRYPTION_KEY_TARGET)!;
    expect(key).toBeTruthy();
    expect(serializedRow).not.toContain(key);
    expect(serializedRow).not.toContain(connection.password);

    // The key was generated fresh and stored ONLY in the credential store — never on disk.
    const fileBytes = readFileSync(result.path);
    expect(fileBytes.includes(Buffer.from(key, 'base64url'))).toBe(false);
  }, 180_000);

  it('detects a byte-flipped (tampered) backup as failed verification, never silently accepted', async () => {
    const backupDir = join(root, 'backups-tamper');
    const created = await createBackup({
      kind: 'manual',
      connection,
      pgBinDir: BIN,
      exeSuffix: EXE,
      backupDir,
      secretStore,
    });
    expect(created.verified).toBe(true);

    // Flip one byte well past the header, inside the ciphertext.
    const bytes = readFileSync(created.path);
    const tamperOffset = Math.min(bytes.length - 1, 100);
    bytes[tamperOffset] = bytes[tamperOffset]! ^ 0xff;
    writeFileSync(created.path, bytes);

    const key = Buffer.from(secretStore.values.get(BACKUP_ENCRYPTION_KEY_TARGET)!, 'base64url');
    const bin = (name: string) => join(BIN, `${name}${EXE}`);
    const result = await verifyBackup({
      encPath: created.path,
      key,
      expectedManifestHash: created.manifestHash,
      expectedRowCounts: created.rowCounts,
      bin,
      conn: connection,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  }, 180_000);

  it('detects a truncated backup file as failed verification', async () => {
    const backupDir = join(root, 'backups-truncate');
    const created = await createBackup({
      kind: 'manual',
      connection,
      pgBinDir: BIN,
      exeSuffix: EXE,
      backupDir,
      secretStore,
    });
    expect(created.verified).toBe(true);

    truncateSync(created.path, 10); // shorter than the 33-byte encryption header

    const key = Buffer.from(secretStore.values.get(BACKUP_ENCRYPTION_KEY_TARGET)!, 'base64url');
    const bin = (name: string) => join(BIN, `${name}${EXE}`);
    const result = await verifyBackup({
      encPath: created.path,
      key,
      expectedManifestHash: created.manifestHash,
      expectedRowCounts: created.rowCounts,
      bin,
      conn: connection,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/shorter than the encryption header/);
  }, 180_000);
});
