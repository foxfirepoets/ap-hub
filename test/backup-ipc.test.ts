import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/auth/session.js';
import { query } from '../src/db/pool.js';
import { runListBackups, runRestoreBackup, runExportBackup, runRestoreExternalBackup, runCreateBackup, runRepairBackup } from '../src/backup/http.js';
import { closeAll, createTenant, createUser, resetTables } from './helpers.js';

/**
 * CHUNK_7_BACKUP — unit coverage for `src/backup/http.ts`, the thin bridge
 * `desktop/ipc/{read,action}/backup.ts` calls. The heavy restore/verify machinery itself is
 * already proven end-to-end by `test/backup-restore.int.test.ts` and `test/backup-rotation.test.ts`;
 * this file covers what this bridge adds: role gating, the response shape (never the
 * encryption key or a credential-store handle), and the fast NOT_FOUND path that runs before
 * any credential-store or filesystem access.
 */

async function tokenFor(tenantId: number, role: string, email: string): Promise<string> {
  const userId = await createUser(tenantId, { role, email });
  return (await createSession(userId)).token;
}

function req(path: string, token: string | null, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function insertBackup(opts: {
  kind?: string;
  path: string;
  verified?: boolean;
  externalCopy?: string | null;
}): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO backups (kind, path, size_bytes, manifest_hash, row_counts, verified_at, external_copy)
     VALUES ($1,$2,100,'deadbeef','{}'::jsonb,$3,$4) RETURNING id`,
    [opts.kind ?? 'manual', opts.path, opts.verified === false ? null : new Date(), opts.externalCopy ?? null],
  );
  return Number(rows[0]!.id);
}

describe('CHUNK_7_BACKUP IPC bridge (src/backup/http.ts)', () => {
  let tenantId = 0;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aphub-backup-ipc-'));
  });

  beforeEach(async () => {
    await resetTables();
    await query('DELETE FROM backups');
    tenantId = await createTenant('Backup IPC Co');
  });

  afterAll(async () => {
    await closeAll();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- runListBackups ---------------------------------------------------------------------

  describe('runListBackups', () => {
    it('401 UNAUTHENTICATED with no session', async () => {
      const res = await runListBackups(req('/api/backup/list', null));
      expect(res.status).toBe(401);
    });

    it('403 FORBIDDEN for bookkeeper and cpa', async () => {
      for (const role of ['bookkeeper', 'cpa']) {
        const token = await tokenFor(tenantId, role, `${role}-list@example.com`);
        const res = await runListBackups(req('/api/backup/list', token));
        expect(res.status).toBe(403);
      }
    });

    it('returns exactly the spec-shaped columns, never the path/hash/row_counts/key', async () => {
      const path = join(tmpDir, 'a.aphubbak');
      const backupId = await insertBackup({ kind: 'scheduled', path, externalCopy: 'D:\\OneDrive\\aphub' });
      const token = await tokenFor(tenantId, 'owner_controller', 'owner-list1@example.com');

      const res = await runListBackups(req('/api/backup/list', token));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<Record<string, unknown>> };
      expect(body.data).toHaveLength(1);
      const row = body.data[0]!;
      expect(Number(row.id)).toBe(backupId);
      expect(row.kind).toBe('scheduled');
      expect(row.externalCopy).toBe('D:\\OneDrive\\aphub');
      expect(row.verifiedAt).not.toBeNull();
      expect(Object.keys(row).sort()).toEqual(
        ['createdAt', 'externalCopy', 'id', 'kind', 'sizeBytes', 'verifiedAt'].sort(),
      );
      const wire = JSON.stringify(body);
      expect(wire).not.toContain('deadbeef'); // manifest_hash
      expect(wire).not.toContain(path); // path
      expect(wire.toLowerCase()).not.toContain('encryption');
    });

    it('an unverified backup still appears (verifiedAt: null), never hidden or silently dropped', async () => {
      await insertBackup({ path: join(tmpDir, 'b.aphubbak'), verified: false });
      const token = await tokenFor(tenantId, 'owner_controller', 'owner-list2@example.com');

      const res = await runListBackups(req('/api/backup/list', token));
      const body = (await res.json()) as { data: Array<Record<string, unknown>> };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.verifiedAt).toBeNull();
    });
  });

  // --- runRestoreBackup ---------------------------------------------------------------------

  describe('runRestoreBackup', () => {
    it('401 UNAUTHENTICATED with no session', async () => {
      const res = await runRestoreBackup(req('/api/backup/1/restore', null, { method: 'POST' }), 1);
      expect(res.status).toBe(401);
    });

    it('403 FORBIDDEN for bookkeeper and cpa, before any backup lookup', async () => {
      for (const role of ['bookkeeper', 'cpa']) {
        const token = await tokenFor(tenantId, role, `${role}-restore@example.com`);
        const res = await runRestoreBackup(req('/api/backup/1/restore', token, { method: 'POST' }), 1);
        expect(res.status).toBe(403);
      }
    });

    it('404 NOT_FOUND for a nonexistent id, without touching the credential store or filesystem', async () => {
      const token = await tokenFor(tenantId, 'owner_controller', 'owner-restore1@example.com');
      const res = await runRestoreBackup(req('/api/backup/987654/restore', token, { method: 'POST' }), 987654);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });

  // --- runExportBackup ----------------------------------------------------------------------

  describe('runExportBackup', () => {
    it('401 UNAUTHENTICATED with no session', async () => {
      const res = await runExportBackup(req('/api/backup/1/export', null, { method: 'POST' }), 1, join(tmpDir, 'x'));
      expect(res.status).toBe(401);
    });

    it('403 FORBIDDEN for bookkeeper and cpa', async () => {
      for (const role of ['bookkeeper', 'cpa']) {
        const token = await tokenFor(tenantId, role, `${role}-export@example.com`);
        const res = await runExportBackup(
          req('/api/backup/1/export', token, { method: 'POST' }),
          1,
          join(tmpDir, 'x'),
        );
        expect(res.status).toBe(403);
      }
    });

    it('404 NOT_FOUND for a nonexistent id', async () => {
      const token = await tokenFor(tenantId, 'owner_controller', 'owner-export1@example.com');
      const res = await runExportBackup(
        req('/api/backup/987654/export', token, { method: 'POST' }),
        987654,
        join(tmpDir, 'x'),
      );
      expect(res.status).toBe(404);
    });

    it('copies the already-encrypted file byte-for-byte to the destination and never reads the key', async () => {
      const source = join(tmpDir, 'source.aphubbak');
      const cipherBytes = Buffer.from('not-really-encrypted-but-opaque-bytes');
      writeFileSync(source, cipherBytes);
      const backupId = await insertBackup({ path: source });
      const destination = join(tmpDir, 'exported.aphubbak');
      const token = await tokenFor(tenantId, 'owner_controller', 'owner-export2@example.com');

      const res = await runExportBackup(
        req(`/api/backup/${backupId}/export`, token, { method: 'POST' }),
        backupId,
        destination,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { exported: boolean; path: string } };
      expect(body.data.exported).toBe(true);
      expect(body.data.path).toBe(destination);
      expect(existsSync(destination)).toBe(true);
      expect(readFileSync(destination)).toEqual(cipherBytes);
      expect(existsSync(`${destination}.meta.json`)).toBe(true);
    });

    it('when destination is a folder, writes aphub-backup-{id}.aphubbak inside it', async () => {
      const source = join(tmpDir, 'folder-source.aphubbak');
      writeFileSync(source, Buffer.from('folder-export-bytes'));
      const backupId = await insertBackup({ path: source });
      const folder = join(tmpDir, 'export-folder');
      const token = await tokenFor(tenantId, 'owner_controller', 'owner-export-folder@example.com');

      const res = await runExportBackup(
        req(`/api/backup/${backupId}/export`, token, { method: 'POST' }),
        backupId,
        folder,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { path: string } };
      expect(body.data.path).toBe(join(folder, `aphub-backup-${backupId}.aphubbak`));
      expect(existsSync(body.data.path)).toBe(true);
      expect(existsSync(`${body.data.path}.meta.json`)).toBe(true);
    });

    it('refuses to export an unverified backup', async () => {
      const source = join(tmpDir, 'unverified.aphubbak');
      writeFileSync(source, Buffer.from('x'));
      const backupId = await insertBackup({ path: source, verified: false });
      const token = await tokenFor(tenantId, 'owner_controller', 'owner-export-unverified@example.com');
      const res = await runExportBackup(
        req(`/api/backup/${backupId}/export`, token, { method: 'POST' }),
        backupId,
        join(tmpDir, 'nope.aphubbak'),
      );
      expect(res.status).toBe(404);
    });
  });

  describe('runCreateBackup auth', () => {
    it('401 UNAUTHENTICATED with no session', async () => {
      const res = await runCreateBackup(req('/api/backup/create', null, { method: 'POST' }));
      expect(res.status).toBe(401);
    });

    it('403 FORBIDDEN for bookkeeper and cpa', async () => {
      for (const role of ['bookkeeper', 'cpa']) {
        const token = await tokenFor(tenantId, role, `${role}-create@example.com`);
        const res = await runCreateBackup(req('/api/backup/create', token, { method: 'POST' }));
        expect(res.status).toBe(403);
      }
    });
  });

  describe('runRestoreExternalBackup auth', () => {
    it('401 UNAUTHENTICATED with no session', async () => {
      const res = await runRestoreExternalBackup(
        req('/api/backup/restore-external', null, { method: 'POST' }),
        join(tmpDir, 'missing.aphubbak'),
      );
      expect(res.status).toBe(401);
    });

    it('403 FORBIDDEN for bookkeeper and cpa', async () => {
      for (const role of ['bookkeeper', 'cpa']) {
        const token = await tokenFor(tenantId, role, `${role}-ext@example.com`);
        const res = await runRestoreExternalBackup(
          req('/api/backup/restore-external', token, { method: 'POST' }),
          join(tmpDir, 'missing.aphubbak'),
        );
        expect(res.status).toBe(403);
      }
    });

    it('404 when the exported file or sidecar is missing', async () => {
      const token = await tokenFor(tenantId, 'owner_controller', 'owner-ext-missing@example.com');
      const res = await runRestoreExternalBackup(
        req('/api/backup/restore-external', token, { method: 'POST' }),
        join(tmpDir, 'does-not-exist.aphubbak'),
      );
      expect(res.status).toBe(404);
    });
  });

  // --- runRepairBackup ---------------------------------------------------------------------
  // The repair logic itself (schema-to-head, referential integrity, install linkage, never
  // touching a user-data table) is proven at the module level by test/backup-repair.int.test.ts;
  // this bridge only adds owner-only gating on top of `runRepair()`.

  describe('runRepairBackup', () => {
    it('401 UNAUTHENTICATED with no session', async () => {
      const res = await runRepairBackup(req('/api/backup/repair', null, { method: 'POST' }));
      expect(res.status).toBe(401);
    });

    it('403 FORBIDDEN for bookkeeper and cpa', async () => {
      for (const role of ['bookkeeper', 'cpa']) {
        const token = await tokenFor(tenantId, role, `${role}-repair@example.com`);
        const res = await runRepairBackup(req('/api/backup/repair', token, { method: 'POST' }));
        expect(res.status).toBe(403);
      }
    });
  });
});
