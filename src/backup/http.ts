import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { AuthError } from '../auth/guard.js';
import { errorResponse, jsonResponse, readContext } from '../services/read/http.js';
import { query as poolQuery } from '../db/pool.js';
import { createHostAdapter } from '../host/index.js';
import { alertBackupFailure } from './alerts.js';
import { createBackup, BackupCreateFailed, type BackupKind } from './create.js';
import { restoreBackup, RestoreFailed, BackupKeyMissing } from './restore.js';
import { runRepair } from './repair.js';
import { withBackupLock } from './lock.js';

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

const BACKUP_META_SUFFIX = '.meta.json';

interface BackupExportMeta {
  format: 'aphub-backup-meta-v1';
  kind: BackupKind;
  manifestHash: string;
  rowCounts: Record<string, number>;
  sizeBytes: number;
  verifiedAt: string;
}

/**
 * Export destination may be a folder (UI copy) or a full file path. `copyFile` needs a file
 * path — if the user nominated a folder, write `aphub-backup-{id}.aphubbak` inside it.
 */
async function resolveExportFilePath(destination: string, backupId: number): Promise<string> {
  const trimmed = destination.trim();
  if (!trimmed) throw Object.assign(new Error('empty destination'), { code: 'EINVAL' });
  try {
    const st = await stat(trimmed);
    if (st.isDirectory()) {
      return join(trimmed, `aphub-backup-${backupId}.aphubbak`);
    }
    return trimmed;
  } catch {
    if (/[/\\]$/.test(trimmed) || extname(trimmed) === '') {
      await mkdir(trimmed, { recursive: true });
      return join(trimmed, `aphub-backup-${backupId}.aphubbak`);
    }
    await mkdir(dirname(trimmed), { recursive: true });
    return trimmed;
  }
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
        createdAt:
          row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        sizeBytes: row.size_bytes,
        verifiedAt:
          row.verified_at === null
            ? null
            : row.verified_at instanceof Date
              ? row.verified_at.toISOString()
              : String(row.verified_at),
        externalCopy: row.external_copy,
      })),
    );
  } catch {
    return errorResponse('BACKUP_FAILED', 'BookScout OS could not load your backup history.', 500);
  }
}

/** `aphub:backup:create` — owner only. Manual "Back up now" (kind=`manual`). Never returns the key. */
export async function runCreateBackup(request: Request): Promise<Response> {
  try {
    await readContext(request, 'owner_controller');
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    return errorResponse('INTERNAL', 'auth failed', 500);
  }

  const conn = resolveConnection();
  if (!conn) return errorResponse('BACKUP_FAILED', 'BookScout OS could not reach its database to back up.', 500);

  const host = createHostAdapter();
  const dataRoot = host.dataDir();
  try {
    const result = await withBackupLock(() =>
      createBackup({
        kind: 'manual',
        connection: conn,
        pgBinDir: process.env.APHUB_PG_BIN_DIR ?? join(process.cwd(), 'vendor', 'pgsql', 'bin'),
        exeSuffix: host.exeSuffix,
        backupDir: process.env.APHUB_BACKUP_DIR ?? join(dataRoot, 'backups'),
        restrictToCurrentUser: host.fsPermissions.restrictToCurrentUser,
        secretStore: host.secretStore,
      }),
    );
    if (!result.verified) {
      alertBackupFailure(
        'BookScout OS made a backup copy but could not confirm it is readable. It was not counted as a usable backup.',
      );
      return errorResponse(
        'BACKUP_FAILED',
        'BookScout OS made a backup copy but could not confirm it is readable. It was not counted.',
        500,
      );
    }
    return jsonResponse({
      id: result.backupId,
      verified: true,
      sizeBytes: result.sizeBytes,
    });
  } catch (err) {
    if (err instanceof BackupCreateFailed) {
      if (isDiskFullError(err) || /disk|ENOSPC|no space/i.test(err.message + (err.detail ?? ''))) {
        alertBackupFailure('BookScout OS paused: your disk is full. Free up space and try again.');
        return errorResponse('DISK_FULL', 'BookScout OS paused: your disk is full. Free up space and try again.', 507);
      }
      alertBackupFailure('BookScout OS could not create a backup.');
      return errorResponse('BACKUP_FAILED', 'BookScout OS could not create a backup.', 500);
    }
    if (isDiskFullError(err)) {
      alertBackupFailure('BookScout OS paused: your disk is full. Free up space and try again.');
      return errorResponse('DISK_FULL', 'BookScout OS paused: your disk is full. Free up space and try again.', 507);
    }
    alertBackupFailure('BookScout OS could not create a backup.');
    return errorResponse('BACKUP_FAILED', 'BookScout OS could not create a backup.', 500);
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
    return errorResponse('RESTORE_FAILED', 'BookScout OS could not reach its database to restore.', 500);
  }

  const conn = resolveConnection();
  if (!conn) return errorResponse('RESTORE_FAILED', 'BookScout OS could not reach its database to restore.', 500);

  const host = createHostAdapter();
  const dataRoot = host.dataDir();
  try {
    const result = await withBackupLock(() =>
      restoreBackup({
        backupId,
        connection: conn,
        pgBinDir: process.env.APHUB_PG_BIN_DIR ?? join(process.cwd(), 'vendor', 'pgsql', 'bin'),
        exeSuffix: host.exeSuffix,
        backupDir: process.env.APHUB_BACKUP_DIR ?? join(dataRoot, 'backups'),
        dataDir: join(dataRoot, 'pgdata'),
        restrictToCurrentUser: host.fsPermissions.restrictToCurrentUser,
        secretStore: host.secretStore,
      }),
    );
    return jsonResponse({ restored: true, rowCounts: result.rowCounts });
  } catch (err) {
    if (err instanceof BackupKeyMissing) {
      alertBackupFailure('BookScout OS could not restore: the backup key is missing from this computer’s secure storage.');
      return errorResponse('BACKUP_KEY_MISSING', err.message, 409);
    }
    if (err instanceof RestoreFailed) {
      if (/no backup found|never verified/.test(err.message)) {
        return errorResponse('NOT_FOUND', 'That backup could not be found.', 404);
      }
      alertBackupFailure('BookScout OS could not restore that backup. Your current data was not changed.');
      return errorResponse('RESTORE_FAILED', err.message, 500);
    }
    if (isDiskFullError(err)) {
      alertBackupFailure('BookScout OS paused: your disk is full. Free up space and try again.');
      return errorResponse('DISK_FULL', 'BookScout OS paused: your disk is full. Free up space and try again.', 507);
    }
    alertBackupFailure('BookScout OS could not restore that backup. Your current data was not changed.');
    return errorResponse('RESTORE_FAILED', 'BookScout OS could not restore that backup. Your current data was not changed.', 500);
  }
}

/** `aphub:backup:export` — owner only. Copies the ALREADY-ENCRYPTED backup file verbatim; the
 *  key stays in the OS credential store and is never read here. Also writes a sidecar
 *  `.meta.json` so a later restore-from-external-folder can re-verify without guessing. */
export async function runExportBackup(request: Request, backupId: number, destination: string): Promise<Response> {
  try {
    await readContext(request, 'owner_controller');
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    return errorResponse('INTERNAL', 'auth failed', 500);
  }
  try {
    const { rows } = await poolQuery<{
      path: string;
      kind: BackupKind;
      size_bytes: number | string;
      manifest_hash: string;
      row_counts: Record<string, number>;
      verified_at: Date | string | null;
    }>(
      `SELECT path, kind, size_bytes, manifest_hash, row_counts, verified_at
         FROM backups WHERE id = $1`,
      [backupId],
    );
    const row = rows[0];
    if (!row) return errorResponse('NOT_FOUND', 'That backup could not be found.', 404);
    if (row.verified_at === null) {
      return errorResponse('NOT_FOUND', 'That backup was never verified and cannot be exported.', 404);
    }
    const outFile = await resolveExportFilePath(destination, backupId);
    await copyFile(row.path, outFile);
    const meta: BackupExportMeta = {
      format: 'aphub-backup-meta-v1',
      kind: row.kind,
      manifestHash: row.manifest_hash,
      rowCounts: row.row_counts,
      sizeBytes: Number(row.size_bytes),
      verifiedAt:
        row.verified_at instanceof Date ? row.verified_at.toISOString() : String(row.verified_at),
    };
    await writeFile(`${outFile}${BACKUP_META_SUFFIX}`, JSON.stringify(meta), 'utf8');
    await poolQuery('UPDATE backups SET external_copy = $2 WHERE id = $1', [backupId, outFile]);
    return jsonResponse({ exported: true, path: outFile });
  } catch (err) {
    if (isDiskFullError(err)) {
      return errorResponse('DISK_FULL', 'BookScout OS paused: your disk is full. Free up space and try again.', 507);
    }
    if ((err as { code?: string } | undefined)?.code === 'ENOENT') {
      return errorResponse('NOT_FOUND', 'The backup file could not be found on disk.', 404);
    }
    return errorResponse('BACKUP_FAILED', 'BookScout OS could not export that backup.', 500);
  }
}

/**
 * `aphub:backup:restore-external` — owner only. Restores from a user-nominated exported file
 * (plus its `.meta.json` sidecar). Never returns the key. Refuses files without a sidecar so
 * we cannot invent row counts or a manifest hash.
 */
export async function runRestoreExternalBackup(request: Request, sourcePath: string): Promise<Response> {
  try {
    await readContext(request, 'owner_controller');
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    return errorResponse('INTERNAL', 'auth failed', 500);
  }

  const trimmed = sourcePath.trim();
  if (!trimmed) {
    return errorResponse('VALIDATION', 'Choose the exported backup file to restore from.', 400);
  }

  const conn = resolveConnection();
  if (!conn) return errorResponse('RESTORE_FAILED', 'BookScout OS could not reach its database to restore.', 500);

  const host = createHostAdapter();
  const dataRoot = host.dataDir();
  const backupDir = process.env.APHUB_BACKUP_DIR ?? join(dataRoot, 'backups');

  try {
    const metaRaw = await readFile(`${trimmed}${BACKUP_META_SUFFIX}`, 'utf8');
    const meta = JSON.parse(metaRaw) as BackupExportMeta;
    if (meta.format !== 'aphub-backup-meta-v1' || !meta.manifestHash || !meta.rowCounts || !meta.verifiedAt) {
      return errorResponse(
        'RESTORE_FAILED',
        'That export is missing its companion info file. Export again from BookScout OS, then restore.',
        500,
      );
    }

    await mkdir(backupDir, { recursive: true });
    const localName = `imported-${Date.now()}-${basename(trimmed)}`;
    const localPath = join(backupDir, localName);
    await copyFile(trimmed, localPath);

    const { rows } = await poolQuery<{ id: number }>(
      `INSERT INTO backups (kind, path, size_bytes, manifest_hash, row_counts, verified_at, external_copy)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id`,
      [
        meta.kind,
        localPath,
        meta.sizeBytes,
        meta.manifestHash,
        JSON.stringify(meta.rowCounts),
        new Date(meta.verifiedAt),
        trimmed,
      ],
    );
    const backupId = Number(rows[0]!.id);

    // The row above is inserted with the SIDECAR'S CLAIMED verified_at, not an independently
    // re-derived one — `restoreBackup` below is where the real decrypt/hash/row-count
    // re-verification happens. If that throws, this row must not survive marked "verified": a
    // corrupted external restore must never be offered back from `aphub:backup:list` as
    // "Checked and readable", and rotation must never treat it as a keepable verified backup.
    try {
      const result = await withBackupLock(() =>
        restoreBackup({
          backupId,
          connection: conn,
          pgBinDir: process.env.APHUB_PG_BIN_DIR ?? join(process.cwd(), 'vendor', 'pgsql', 'bin'),
          exeSuffix: host.exeSuffix,
          backupDir,
          dataDir: join(dataRoot, 'pgdata'),
          restrictToCurrentUser: host.fsPermissions.restrictToCurrentUser,
          secretStore: host.secretStore,
        }),
      );
      return jsonResponse({ restored: true, rowCounts: result.rowCounts });
    } catch (err) {
      await poolQuery('DELETE FROM backups WHERE id = $1', [backupId]).catch(() => {});
      await rm(localPath, { force: true }).catch(() => {});
      throw err;
    }
  } catch (err) {
    if (err instanceof BackupKeyMissing) {
      alertBackupFailure('BookScout OS could not restore: the backup key is missing from this computer’s secure storage.');
      return errorResponse('BACKUP_KEY_MISSING', err.message, 409);
    }
    if (err instanceof RestoreFailed) {
      alertBackupFailure('BookScout OS could not restore from that exported backup. Your current data was not changed.');
      return errorResponse('RESTORE_FAILED', err.message, 500);
    }
    if ((err as { code?: string } | undefined)?.code === 'ENOENT') {
      return errorResponse(
        'NOT_FOUND',
        'That exported backup (or its companion info file) could not be found.',
        404,
      );
    }
    if (isDiskFullError(err)) {
      alertBackupFailure('BookScout OS paused: your disk is full. Free up space and try again.');
      return errorResponse('DISK_FULL', 'BookScout OS paused: your disk is full. Free up space and try again.', 507);
    }
    alertBackupFailure('BookScout OS could not restore from that exported backup. Your current data was not changed.');
    return errorResponse('RESTORE_FAILED', 'BookScout OS could not restore from that exported backup. Your current data was not changed.', 500);
  }
}

/**
 * `aphub:backup:repair` — owner only. Brings the schema to head (idempotent no-op when already
 * there), re-checks referential integrity and install/credential-store linkage (`repair.ts`).
 * Never writes to a user-data table. This is what `desktop/ipc/errors.ts` and
 * `app/lib/onboardingErrors.ts` point the user at with "use Repair if this keeps happening" —
 * previously unreachable from the product; this is the entry point.
 */
export async function runRepairBackup(request: Request): Promise<Response> {
  try {
    await readContext(request, 'owner_controller');
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    return errorResponse('INTERNAL', 'auth failed', 500);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return errorResponse('BACKUP_FAILED', 'BookScout OS could not reach its database to repair.', 500);

  const host = createHostAdapter();
  const dataRoot = host.dataDir();
  try {
    const result = await withBackupLock(() =>
      runRepair({
        connectionString: databaseUrl,
        migrationsDir: process.env.APHUB_MIGRATIONS_DIR,
        installFilePath: join(dataRoot, 'install.json'),
        secretStore: host.secretStore,
        // Mirrors desktop/database.ts's boot-path pre-migration backup — if repair happens to
        // find pending migrations, they must not run without the same safety net the normal
        // startup path already gets (FMA F2).
        onBeforeMigrating: async () => {
          const conn = resolveConnection();
          if (!conn) return; // no DATABASE_URL parse-ability; migrateUp itself will surface the real error
          const preMigration = await createBackup({
            kind: 'pre_migration',
            connection: conn,
            pgBinDir: process.env.APHUB_PG_BIN_DIR ?? join(process.cwd(), 'vendor', 'pgsql', 'bin'),
            exeSuffix: host.exeSuffix,
            backupDir: process.env.APHUB_BACKUP_DIR ?? join(dataRoot, 'backups'),
            restrictToCurrentUser: host.fsPermissions.restrictToCurrentUser,
            secretStore: host.secretStore,
          });
          if (!preMigration.verified) {
            alertBackupFailure(
              'BookScout OS is repairing your data and made a safety backup first, but could not confirm it is readable.',
            );
          }
        },
      }),
    );
    if (!result.ok) {
      return errorResponse(
        'BACKUP_FAILED',
        'BookScout OS checked your data and found a problem it could not fix on its own. Contact support.',
        500,
      );
    }
    return jsonResponse({
      repaired: true,
      migrationsApplied: result.migrationsApplied.length,
      backupKeyPresent: result.backupKeyPresent,
    });
  } catch {
    return errorResponse('BACKUP_FAILED', 'BookScout OS could not complete repair.', 500);
  }
}
