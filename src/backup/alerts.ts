/**
 * Plain-language backup failure alerts for the desktop shell.
 *
 * `src/backup/**` must not import Electron. The main process registers an alerter once
 * at boot; backup create/nightly code calls `alertBackupFailure` so a failed backup is
 * never silent (CHUNK_7_BACKUP acceptance: visible warning + native notification).
 */

type Alerter = (message: string) => void;

let alerter: Alerter | null = null;

export function setBackupFailureAlerter(fn: Alerter | null): void {
  alerter = fn;
}

export function alertBackupFailure(message: string): void {
  try {
    alerter?.(message);
  } catch {
    // Alerting must never break the backup path itself.
  }
}
