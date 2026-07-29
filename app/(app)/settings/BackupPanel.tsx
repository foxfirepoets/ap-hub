'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiGet, apiPost } from '../../lib/api';
import type { BackupRecord } from '../../lib/types';

// CHUNK_7_BACKUP UI — HTTP-shaped paths mapped to aphub:backup:* via app/lib/ipc-routes.ts.
const LIST_PATH = '/api/backup/list';
const CREATE_PATH = '/api/backup/create';
const RESTORE_EXTERNAL_PATH = '/api/backup/restore-external';
const REPAIR_PATH = '/api/backup/repair';
const RESTORE_CONFIRMATION = 'RESTORE';

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (dayDiff === 0) return `Today, ${time}`;
  if (dayDiff === 1) return `Yesterday, ${time}`;
  if (dayDiff > 1 && dayDiff < 7) return `${date.toLocaleDateString(undefined, { weekday: 'long' })}, ${time}`;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

function formatSize(bytes: number | string): string {
  const n = typeof bytes === 'number' ? bytes : Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function asBackupId(id: number | string): number {
  return typeof id === 'number' ? id : Number(id);
}

export function BackupPanel({ owner }: { owner: boolean }) {
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'good' | 'bad'; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [exportBusyId, setExportBusyId] = useState<number | null>(null);
  const [exportDestination, setExportDestination] = useState('');
  const [externalRestorePath, setExternalRestorePath] = useState('');
  const [restoreTarget, setRestoreTarget] = useState<BackupRecord | null>(null);
  const [restoreExternal, setRestoreExternal] = useState(false);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [restoreTyped, setRestoreTyped] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<BackupRecord[]>(LIST_PATH);
      setBackups(Array.isArray(data) ? data : []);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Backup status is temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(), [load]);

  const latestVerified = backups
    .filter((b) => b.verifiedAt)
    .sort((a, b) => new Date(b.verifiedAt as string).getTime() - new Date(a.verifiedAt as string).getTime())[0];

  async function backUpNow() {
    setCreating(true);
    setNotice(null);
    const result = await apiPost<{ id: number; verified?: boolean }>(CREATE_PATH);
    setCreating(false);
    if (result.ok) {
      setNotice({
        kind: 'good',
        text: 'Backup finished and checked. It is listed below as readable.',
      });
      await load();
    } else {
      setNotice({ kind: 'bad', text: result.error?.message ?? 'Could not finish a backup. Try again.' });
    }
  }

  async function exportBackup(backup: BackupRecord) {
    if (!exportDestination.trim()) {
      setNotice({ kind: 'bad', text: 'Choose a folder to export the backup to first.' });
      return;
    }
    const id = asBackupId(backup.id);
    setExportBusyId(id);
    setNotice(null);
    const result = await apiPost<{ exported: boolean; path?: string }>(`/api/backup/${id}/export`, {
      destination: exportDestination.trim(),
    });
    setExportBusyId(null);
    if (result.ok) {
      setNotice({
        kind: 'good',
        text: 'Backup exported. The key to open it still lives only on this computer — keep this computer\'s secure storage, or you cannot restore later.',
      });
      await load();
    } else {
      setNotice({ kind: 'bad', text: result.error?.message ?? 'Export failed. The backup was not changed.' });
    }
  }

  async function confirmRestore() {
    setRestoreBusy(true);
    setNotice(null);
    const result = restoreExternal
      ? await apiPost<{ restored: boolean }>(RESTORE_EXTERNAL_PATH, {
          path: externalRestorePath.trim(),
        })
      : restoreTarget
        ? await apiPost<{ restored: boolean }>(`/api/backup/${asBackupId(restoreTarget.id)}/restore`, {
            backupId: asBackupId(restoreTarget.id),
          })
        : { ok: false as const, error: { message: 'Nothing selected to restore.' } };
    setRestoreBusy(false);
    if (result.ok) {
      setNotice({ kind: 'good', text: 'Restore complete. Your data now matches the selected backup.' });
      setRestoreTarget(null);
      setRestoreExternal(false);
      setRestoreConfirmed(false);
      setRestoreTyped('');
      await load();
    } else {
      setNotice({
        kind: 'bad',
        text: result.error?.message ?? 'Restore failed. Your current data was not changed.',
      });
    }
  }

  async function runRepair() {
    setRepairing(true);
    setNotice(null);
    const result = await apiPost<{ repaired: boolean }>(REPAIR_PATH);
    setRepairing(false);
    if (result.ok) {
      setNotice({ kind: 'good', text: 'Repair finished. Your data was not changed.' });
      await load();
    } else {
      setNotice({ kind: 'bad', text: result.error?.message ?? 'Repair could not finish. Try again.' });
    }
  }

  function openExternalRestore() {
    if (!externalRestorePath.trim()) {
      setNotice({ kind: 'bad', text: 'Choose the exported backup file first.' });
      return;
    }
    setRestoreExternal(true);
    setRestoreTarget(null);
    setRestoreConfirmed(false);
    setRestoreTyped('');
    setNotice(null);
  }

  return (
    <div className="panel" data-testid="backup-panel">
      <h2>Backups</h2>

      {loading ? <p className="muted" data-testid="backup-loading">Checking backup status…</p> : null}

      {!loading && error ? (
        <div className="notice bad" data-testid="backup-error">
          {error} <button onClick={() => void load()}>Try again</button>
        </div>
      ) : null}

      {!loading && !error ? (
        latestVerified ? (
          <p data-testid="backup-latest">
            Most recent verified backup: <strong>{formatWhen(latestVerified.verifiedAt as string)}</strong> —
            checked and readable ({formatSize(latestVerified.sizeBytes)}).
          </p>
        ) : (
          <div className="notice warn" data-testid="backup-none">
            No verified backup yet. Back up now to protect your data.
          </div>
        )
      ) : null}

      {notice ? (
        <div className={`notice ${notice.kind}`} data-testid="backup-notice" role="status">
          {notice.text}
        </div>
      ) : null}

      {owner ? (
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button
            className="primary"
            disabled={creating}
            onClick={() => void backUpNow()}
            data-testid="backup-now"
          >
            {creating ? 'Backing up…' : 'Back up now'}
          </button>
          <button
            disabled={repairing}
            onClick={() => void runRepair()}
            data-testid="backup-repair"
          >
            {repairing ? 'Repairing…' : 'Repair'}
          </button>
        </div>
      ) : (
        <p className="muted">Only the account owner can start a backup, export, or restore.</p>
      )}

      {!loading && !error && backups.length > 0 ? (
        <table className="table" data-testid="backup-list" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>Size</th>
              <th>Status</th>
              {owner ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {backups.map((backup) => {
              const id = asBackupId(backup.id);
              return (
                <tr key={id} data-testid={`backup-row-${id}`}>
                  <td>{formatWhen(backup.createdAt)}</td>
                  <td>{backup.kind.replaceAll('_', ' ')}</td>
                  <td>{formatSize(backup.sizeBytes)}</td>
                  <td>
                    <span className={`badge ${backup.verifiedAt ? 'good' : 'warn'}`}>
                      {backup.verifiedAt ? 'Checked and readable' : 'Not yet verified'}
                    </span>
                    {backup.externalCopy ? (
                      <span className="muted"> · also saved outside this computer</span>
                    ) : null}
                  </td>
                  {owner ? (
                    <td>
                      <div className="btn-row">
                        <button
                          disabled={!backup.verifiedAt || exportBusyId === id}
                          onClick={() => void exportBackup(backup)}
                          data-testid={`backup-export-${id}`}
                        >
                          {exportBusyId === id ? 'Exporting…' : 'Export'}
                        </button>
                        <button
                          className="danger"
                          disabled={!backup.verifiedAt}
                          onClick={() => {
                            setRestoreTarget(backup);
                            setRestoreExternal(false);
                            setRestoreConfirmed(false);
                            setRestoreTyped('');
                            setNotice(null);
                          }}
                          data-testid={`backup-restore-${id}`}
                        >
                          Restore
                        </button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      {owner && backups.some((b) => b.verifiedAt) ? (
        <label className="field-row" style={{ marginTop: 10 }}>
          <span>Export folder (OneDrive, Drive, Dropbox, network share, or external drive)</span>
          <input
            type="text"
            value={exportDestination}
            onChange={(event) => setExportDestination(event.target.value)}
            placeholder="e.g. D:\BookScout OS Backups"
            data-testid="backup-export-destination"
          />
        </label>
      ) : null}

      {owner ? (
        <div style={{ marginTop: 14 }}>
          <label className="field-row">
            <span>Restore from an exported backup file</span>
            <input
              type="text"
              value={externalRestorePath}
              onChange={(event) => setExternalRestorePath(event.target.value)}
              placeholder="e.g. D:\BookScout OS Backups\aphub-backup-3.aphubbak"
              data-testid="backup-external-path"
            />
          </label>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button
              className="danger"
              onClick={() => openExternalRestore()}
              data-testid="backup-restore-external"
            >
              Restore from exported file…
            </button>
          </div>
          <p className="muted" style={{ marginTop: 6 }}>
            The key that unlocks the export still lives only on this computer's secure storage.
          </p>
        </div>
      ) : null}

      {restoreTarget || restoreExternal ? (
        <div className="panel" data-testid="backup-restore-confirm">
          <strong>
            {restoreExternal
              ? 'Restore from the exported backup file?'
              : `Restore from ${formatWhen(restoreTarget!.createdAt)}?`}
          </strong>
          <p className="muted">
            This replaces all current data on this computer with this backup. Anything created or
            changed since then will be lost. This cannot be undone.
          </p>
          <label>
            <input
              type="checkbox"
              checked={restoreConfirmed}
              onChange={(event) => setRestoreConfirmed(event.target.checked)}
            />{' '}
            I understand this replaces all current data with this backup.
          </label>
          <label className="field-row">
            <span>Type {RESTORE_CONFIRMATION} to confirm</span>
            <input
              type="text"
              value={restoreTyped}
              onChange={(event) => setRestoreTyped(event.target.value)}
            />
          </label>
          <div className="btn-row">
            <button
              className="danger"
              disabled={restoreBusy || !restoreConfirmed || restoreTyped !== RESTORE_CONFIRMATION}
              onClick={() => void confirmRestore()}
              data-testid="backup-restore-confirm-button"
            >
              {restoreBusy ? 'Restoring…' : 'Restore now'}
            </button>
            <button
              disabled={restoreBusy}
              onClick={() => {
                setRestoreTarget(null);
                setRestoreExternal(false);
                setRestoreConfirmed(false);
                setRestoreTyped('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
