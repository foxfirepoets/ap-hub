import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import pg from 'pg';
import { buildConnectionString } from '../db/postgres-runtime.js';
import { decryptFile, BackupCorrupted } from './crypto.js';
import { hashFile, captureRowCounts, rowCountsMatch, BACKUP_TABLES } from './manifest.js';
import { runPgTool, type PgConnection } from './pg-tools.js';

const { Pool } = pg;

export interface VerifyBackupOptions {
  encPath: string;
  key: Buffer;
  expectedManifestHash: string;
  expectedRowCounts: Record<string, number>;
  bin: (name: string) => string;
  conn: PgConnection;
  tables?: readonly string[];
}

export interface VerifyBackupResult {
  ok: boolean;
  reason?: string;
}

/**
 * The one piece of this chunk the whole spec exists for: prove a backup is real by actually
 * decrypting it and reading it back, not by trusting that the write succeeded.
 *
 * Three checks, in order, any of which can fail the backup:
 *   1. Decrypt — GCM authentication catches a corrupted or tampered ciphertext outright.
 *   2. Manifest hash — the decrypted dump's sha256 must equal the hash taken before encryption.
 *   3. Restore + row counts — the decrypted dump is actually restored into a throwaway
 *      database (via the same bundled `pg_restore`) and its row counts for the tracked tables
 *      must match what the live database held at backup time. This is what proves the archive
 *      is restorable, not merely byte-identical to something we wrote a minute ago.
 *
 * A scratch database is created and dropped on the SAME running instance the backup was taken
 * from — cheap, and it never touches the real application database.
 */
export async function verifyBackup(opts: VerifyBackupOptions): Promise<VerifyBackupResult> {
  const tables = opts.tables ?? BACKUP_TABLES;
  const decPath = `${opts.encPath}.verify-${randomBytes(4).toString('hex')}.tmp`;

  try {
    try {
      await decryptFile(opts.encPath, decPath, opts.key);
    } catch (err) {
      if (err instanceof BackupCorrupted) return { ok: false, reason: err.message };
      throw err;
    }

    const actualHash = await hashFile(decPath);
    if (actualHash !== opts.expectedManifestHash) {
      return { ok: false, reason: 'manifest hash mismatch after decrypting the backup' };
    }

    const scratchDb = `aphub_backup_verify_${randomBytes(6).toString('hex')}`;
    await runPgTool(opts.bin, 'createdb', [scratchDb], opts.conn);
    try {
      try {
        await runPgTool(opts.bin, 'pg_restore', ['-d', scratchDb, decPath], opts.conn, 300_000);
      } catch (err) {
        return {
          ok: false,
          reason: `restoring the decrypted dump failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const scratchPool = new Pool({
        connectionString: buildConnectionString({
          user: opts.conn.user,
          password: opts.conn.password,
          port: opts.conn.port,
          database: scratchDb,
        }),
      });
      try {
        const actualCounts = await captureRowCounts(scratchPool, tables);
        if (!rowCountsMatch(opts.expectedRowCounts, actualCounts)) {
          return { ok: false, reason: 'row counts in the restored backup do not match the source database' };
        }
        return { ok: true };
      } finally {
        await scratchPool.end();
      }
    } finally {
      await runPgTool(opts.bin, 'dropdb', ['--if-exists', scratchDb], opts.conn);
    }
  } finally {
    await rm(decPath, { force: true });
  }
}
