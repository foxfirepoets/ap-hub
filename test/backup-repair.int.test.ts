import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { startLocalDatabase } from '../src/db/local-database';
import { migrateUp } from '../src/db/migrate';
import type { SecretStore } from '../src/host/types';
import { runRepair } from '../src/backup/repair';
import { getOrCreateBackupKey, BACKUP_ENCRYPTION_KEY_TARGET } from '../src/backup/key';
import { BACKUP_TABLES } from '../src/backup/manifest';

/**
 * CHUNK_7_BACKUP — repair mode's data-safety proof.
 *
 * Uses its own private bundled cluster on a probed port (same pattern as
 * `test/backup-create.int.test.ts` / `test/local-database.int.test.ts`) rather than the shared
 * `DATABASE_URL` test instance, so it never contends with another agent's suite.
 *
 * Skips (rather than fails) when `vendor/pgsql` is absent.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BIN = join(ROOT, 'vendor', 'pgsql', 'bin');
const MIGRATIONS = join(ROOT, 'migrations');
const EXE = process.platform === 'win32' ? '.exe' : '';
const AVAILABLE = existsSync(join(BIN, `initdb${EXE}`));

const describeIf = AVAILABLE ? describe : describe.skip;

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

// The real source-of-truth user-data tables (spec's own list, `manifest.ts`), plus `tenants`,
// the parent every one of them hangs off.
const SNAPSHOT_TABLES = ['tenants', ...BACKUP_TABLES] as const;

type TableSnapshot = Record<string, { rowCount: number; hash: string }>;

/**
 * Row-level (not just row-count) snapshot: every column of every row, ordered by id, hashed.
 * Two snapshots are equal only if every row's every column round-tripped unchanged.
 */
// attachment_blobs has no surrogate `id` (its primary key is the content hash, sha256) — every
// other tracked table orders by `id`.
const ORDER_COLUMN: Record<string, string> = { attachment_blobs: 'sha256' };

async function snapshot(pool: pg.Pool): Promise<TableSnapshot> {
  const out: TableSnapshot = {};
  for (const table of SNAPSHOT_TABLES) {
    const orderBy = ORDER_COLUMN[table] ?? 'id';
    const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
    out[table] = {
      rowCount: rows.length,
      hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  return out;
}

describeIf('runRepair — row-level before/after proof against real bundled PostgreSQL', () => {
  let root: string;
  let secretStore: MemorySecretStore;
  let pool: pg.Pool;
  let installFilePath: string;
  let connectionString: string;
  let tenantId: number;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'aphub-repair-int-'));
    secretStore = new MemorySecretStore();
    installFilePath = join(root, 'install.json');

    const started = await startLocalDatabase({
      binDir: BIN,
      dataDir: join(root, 'pgdata'),
      installFilePath,
      logDir: join(root, 'logs'),
      exeSuffix: EXE,
      platform: 'win32',
      appVersion: '0.0.0-repair-int',
      osAccountId: 'S-1-5-21-repair-int',
      secretStore,
      migrate: (url: string) => migrateUp(url, MIGRATIONS),
    });
    stop = () => started.postgres.stop();
    connectionString = started.connectionString;
    pool = new pg.Pool({ connectionString });

    // Repair also checks for the backup key's presence — seed it so that check has something
    // real to find, the same way createBackup would have left it.
    await getOrCreateBackupKey(secretStore);

    // Seed one real row in every table repair's row-level proof and integrity checks touch.
    const tenant = await pool.query<{ id: number }>(
      `INSERT INTO tenants (name) VALUES ('Repair Test Co') RETURNING id`,
    );
    tenantId = tenant.rows[0]!.id;
    const msg = await pool.query<{ id: number }>(
      `INSERT INTO messages (tenant_id, gmail_message_id, subject) VALUES ($1, 'msg-repair-1', 'Invoice #1') RETURNING id`,
      [tenantId],
    );
    const messageId = msg.rows[0]!.id;
    await pool.query(
      `INSERT INTO attachment_blobs (sha256, bytes, mime, size) VALUES ('repairbeef', '\\x0a0b0c0d'::bytea, 'application/pdf', 4)`,
    );
    const att = await pool.query<{ id: number }>(
      `INSERT INTO attachments (tenant_id, message_id, filename, sha256, size) VALUES ($1, $2, 'invoice-repair.pdf', 'repairbeef', 4) RETURNING id`,
      [tenantId, messageId],
    );
    const attachmentId = att.rows[0]!.id;
    const prop = await pool.query<{ id: number }>(
      `INSERT INTO proposals (tenant_id, attachment_id, proposed_txn) VALUES ($1, $2, '{"amount": "12.34"}'::jsonb) RETURNING id`,
      [tenantId, attachmentId],
    );
    const proposalId = prop.rows[0]!.id;
    await pool.query(
      `INSERT INTO postings (tenant_id, attachment_id, proposal_id, idempotency_key) VALUES ($1, $2, $3, 'idem-repair-1')`,
      [tenantId, attachmentId, proposalId],
    );
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await stop?.();
    rmSync(root, { recursive: true, force: true });
  });

  it('proves repair never mutates user data: row-level hash of every tracked table is identical before and after', async () => {
    const before = await snapshot(pool);
    expect(before.tenants!.rowCount).toBe(1);
    expect(before.messages!.rowCount).toBe(1);
    expect(before.attachments!.rowCount).toBe(1);
    expect(before.attachment_blobs!.rowCount).toBe(1);
    expect(before.proposals!.rowCount).toBe(1);
    expect(before.postings!.rowCount).toBe(1);

    const result = await runRepair({
      connectionString,
      migrationsDir: MIGRATIONS,
      installFilePath,
      secretStore,
    });

    // Schema was already at head (startLocalDatabase ran migrate on boot) — repair performs
    // zero migration writes, exactly as src/db/migrate.ts's own idempotency guarantees.
    expect(result.migrationsApplied).toEqual([]);
    expect(result.installLinkageOk).toBe(true);
    expect(result.backupKeyPresent).toBe(true);
    expect(result.integrityChecks.length).toBeGreaterThan(0);
    for (const check of result.integrityChecks) {
      expect(check.ok).toBe(true);
      expect(check.orphanCount).toBe(0);
    }
    expect(result.ok).toBe(true);

    const after = await snapshot(pool);
    for (const table of SNAPSHOT_TABLES) {
      expect(after[table]).toEqual(before[table]);
    }
  }, 180_000);

  it('detects a bypassed foreign-key invariant instead of trivially passing', async () => {
    // Prove the orphan check actually fires: temporarily disable the constraint-enforcement
    // triggers (the only way to reach this state — a live FK stops the same INSERT outright),
    // insert an orphan postings_ap row, then restore enforcement and clean up.
    await pool.query('ALTER TABLE postings_ap DISABLE TRIGGER ALL');
    let orphanId: number;
    try {
      const orphan = await pool.query<{ id: number }>(
        `INSERT INTO postings_ap (tenant_id, proposal_id, idempotency_key) VALUES ($1, 999999999, 'idem-orphan-1') RETURNING id`,
        [tenantId],
      );
      orphanId = orphan.rows[0]!.id;
    } finally {
      await pool.query('ALTER TABLE postings_ap ENABLE TRIGGER ALL');
    }

    try {
      const result = await runRepair({
        connectionString,
        migrationsDir: MIGRATIONS,
        installFilePath,
        secretStore,
      });

      expect(result.ok).toBe(false);
      const check = result.integrityChecks.find((c) => c.name.includes('postings_ap'));
      expect(check?.ok).toBe(false);
      expect(check?.orphanCount).toBe(1);
    } finally {
      await pool.query('ALTER TABLE postings_ap DISABLE TRIGGER ALL');
      await pool.query('DELETE FROM postings_ap WHERE id = $1', [orphanId]);
      await pool.query('ALTER TABLE postings_ap ENABLE TRIGGER ALL');
    }
  }, 180_000);

  it('detects a mismatched install.json without altering any user-data table', async () => {
    const original = readFileSync(installFilePath, 'utf8');
    const before = await snapshot(pool);
    try {
      const tampered = JSON.parse(original);
      tampered.osAccountId = 'S-1-5-21-someone-else';
      writeFileSync(installFilePath, JSON.stringify(tampered));

      const result = await runRepair({
        connectionString,
        migrationsDir: MIGRATIONS,
        installFilePath,
        secretStore,
      });

      expect(result.installLinkageOk).toBe(false);
      expect(result.installLinkageDetail).toMatch(/does not match/);
      expect(result.ok).toBe(false);
    } finally {
      writeFileSync(installFilePath, original);
    }

    const after = await snapshot(pool);
    for (const table of SNAPSHOT_TABLES) {
      expect(after[table]).toEqual(before[table]);
    }
  }, 180_000);

  it('never returns the backup key itself', async () => {
    const result = await runRepair({
      connectionString,
      migrationsDir: MIGRATIONS,
      installFilePath,
      secretStore,
    });
    const serialized = JSON.stringify(result);
    const key = secretStore.values.get(BACKUP_ENCRYPTION_KEY_TARGET)!;
    expect(key).toBeTruthy();
    expect(serialized).not.toContain(key);
  }, 180_000);
});
