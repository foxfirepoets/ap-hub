/**
 * CHUNK_7_BACKUP — serializes every operation that creates, restores, or repairs a backup
 * against the same live database and the same backup encryption key.
 *
 * Why this exists (found by a failure-mode audit, not by a bug report): `getOrCreateBackupKey`
 * (`key.ts`) is check-then-act — two concurrent first-ever `createBackup()` calls each mint a
 * DIFFERENT key and store it; whichever `put()` lands last wins, and the other call's
 * already-"verified" backup becomes permanently, silently undecryptable. Concurrent
 * `restoreBackup()` calls are worse: the rename-swap writes ONE crash-recovery marker file per
 * data directory (`restoreSwapMarkerPath`), so a second concurrent restore overwrites the
 * first's marker, and a restore's `terminateConnections` can kill an in-flight `pg_dump` from a
 * concurrent backup. All of AP-Hub's backup entry points run inside this one Electron main
 * process — a single Node event loop — so a simple in-process promise queue removes the race
 * entirely; no OS-level file lock is needed.
 */
let queue: Promise<void> = Promise.resolve();

/** Runs `fn` only after every previously-queued backup operation has settled (success or
 *  failure) — never overlapping with another `withBackupLock` call in this process. */
export function withBackupLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
