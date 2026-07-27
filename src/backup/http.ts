import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthError } from '../auth/guard.js';
import { errorResponse, jsonResponse, readContext } from '../services/read/http.js';
import { query as poolQuery } from '../db/pool.js';
import { createHostAdapter } from '../host/index.js';
import type { BackupKind } from './create.js';
import { restoreBackup, RestoreFailed, BackupKeyMissing } from './restore.js';

/**
 * CHUNK_7_BACKUP — the thin bridge between `desktop/ipc/{read,action}/backup.ts` and the real
 * backup module (`src/backup/*`). Same shape as `src/accounting/write-gates-http.ts`: ALL
 * logic — auth, connection/host resolution, error mapping — lives here where lint/typecheck/
 * test cover it; the IPC entries only wire a channel to one `run*` function.
 *
 * `backups` is a whole-install table, not tenant-scoped (`migrations/015_backups.sql`,
 * `src/backup/rotation.ts`'s "Not tenant-scoped" note), so these handlers check the caller's
 * ROLE via `readContext` but never scope a query by `ctx.tenantId`.
 *
 * Nothing here ever reads or returns the backup encryption key or a credential-store handle —
 * `runListBackups` selects only the columns the spec's response shape names, and
 * `runExportBackup` copies the already-encrypted file byte-for-byte without touching
 * `BACKUP_ENCRYPTION_KEY_TARGET`.
 */

/** Mirrors the columns `aphub:backup:list` is allowed to return (spec §"Endpoints"). */
interface BackupListRow {
  id: number | string;
  kind: BackupKind;
  created_at: Date | string;
  size_bytes: number | string;
  verified_at: Date | string | null;
  external_copy: string | null;
}

/** True for the Node `ENOSPC` a full disk raises from `pg_dump`/`copyFile`/`writeFile`. */
function isDiskFullError(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ENOSPC';
}

/**
 * The live database connection, resolved from `DATABASE_URL` — the same env var
 * `desktop/main.ts` sets from the running bundled Postgres instance before any IPC channel can
 * be reached, and the same resolution `backupNightlyHandler` (`src/backup/rotation.ts`) uses.
 */
function resolveConnection(): { host: string; port: number; user: string; password: string; database: string } | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
}

/** `aphub:backup:list` — owner only. Never returns the key or a credential-store handle. */
export async function runListBackups(request: Request): Promise<Response> {
  try {
    await readContext(request, 'owner_controller');
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    return errorResponse('INTERNAL', 'auth failed', 500);
  }
  try {
    const { rows } = await poolQuery<BackupListRow>(
      'SELECT id, kind, created_at, size_bytes, verified_at, external_copy FROM backups ORDER BY created_at DESC',
    );
    return jsonResponse(
      rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        createdAt: row.created_at,
        sizeBytes: row.size_bytes,
        verifiedAt: row.verified_at,
        externalCopy: row.external_copy,
      })),
    );
  } catch {
    return errorResponse('BACKUP_FAILED', 'AP-Hub could not load your backup history.', 500);
  }
}

/** `aphub:backup:restore` — owner only. Refuses (via `restoreBackup` itself) a backup that
 *  never verified; the live database is left untouched on any failure. */
export async function runRestoreBackup(request: Request, backupId: number): Promise<Response> {
  try {
    await readContext(request, 'owner_controller');
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    return errorResponse('INTERNAL', 'auth failed', 500);
  }

  // Cheap existence check before anything touches the credential store or the filesystem:
  // `restoreBackup` re-checks this authoritatively (and is the one that matters — this is a
  // fast-fail, not the security boundary), but a bad id should never reach `getOrCreateBackupKey`
  // or `mkdir` at all.
  try {
    const { rows } = await poolQuery<{ id: number }>('SELECT id FROM backups WHERE id = $1', [backupId]);
    if (!rows[0]) return errorResponse('NOT_FOUND', 'That backup could not be found.', 404);
  } catch {
    return errorResponse('RESTORE_FAILED', 'AP-Hub could not reach its database to restore.', 500);
  }

  const conn = resolveConnection();
  if (!conn) return errorResponse('RESTORE_FAILED', 'AP-Hub could not reach its database to restore.', 500);

  const host = createHostAdapter();
  const dataRoot = host.dataDir();
  try {
    const result = await restoreBackup({
      backupId,
      connection: conn,
      pgBinDir: process.env.APHUB_PG_BIN_DIR ?? join(process.cwd(), 'vendor', 'pgsql', 'bin'),
      exeSuffix: host.exeSuffix,
      backupDir: process.env.APHUB_BACKUP_DIR ?? join(dataRoot, 'backups'),
      dataDir: join(dataRoot, 'pgdata'),
      restrictToCurrentUser: host.fsPermissions.restrictToCurrentUser,
      secretStore: host.secretStore,
    });
    return jsonResponse({ restored: true, rowCounts: result.rowCounts });
  } catch (err) {
    if (err instanceof BackupKeyMissing) return errorResponse('BACKUP_KEY_MISSING', err.message, 409);
    if (err instanceof RestoreFailed) {
      if (/no backup found|never verified/.test(err.message)) {
        return errorResponse('NOT_FOUND', 'That backup could not be found.', 404);
      }
      return errorResponse('RESTORE_FAILED', err.message, 500);
    }
    if (isDiskFullError(err)) {
      return errorResponse('DISK_FULL', 'AP-Hub paused: your disk is full. Free up space and try again.', 507);
    }
    return errorResponse('RESTORE_FAILED', 'AP-Hub could not restore that backup. Your current data was not changed.', 500);
  }
}

/** `aphub:backup:export` — owner only. Copies the ALREADY-ENCRYPTED backup file verbatim; the
 *  key stays in the OS credential store and is never read here. */
export async function runExportBackup(request: Request, backupId: number, destination: string): Promise<Response> {
  try {
    await readContext(request, 'owner_controller');
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    return errorResponse('INTERNAL', 'auth failed', 500);
  }
  try {
    const { rows } = await poolQuery<{ path: string }>('SELECT path FROM backups WHERE id = $1', [backupId]);
    const row = rows[0];
    if (!row) return errorResponse('NOT_FOUND', 'That backup could not be found.', 404);
    await copyFile(row.path, destination);
    return jsonResponse({ exported: true });
  } catch (err) {
    if (isDiskFullError(err)) {
      return errorResponse('DISK_FULL', 'AP-Hub paused: your disk is full. Free up space and try again.', 507);
    }
    if ((err as { code?: string } | undefined)?.code === 'ENOENT') {
      return errorResponse('NOT_FOUND', 'The backup file could not be found on disk.', 404);
    }
    return errorResponse('BACKUP_FAILED', 'AP-Hub could not export that backup.', 500);
  }
}
