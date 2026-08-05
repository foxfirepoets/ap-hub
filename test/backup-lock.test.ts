import { describe, it, expect } from 'vitest';
import { withBackupLock } from '../src/backup/lock.js';

/**
 * CHUNK_7_BACKUP — the fix for the failure-mode audit's F1/F3/F4 findings: two concurrent
 * backup-mutating calls (e.g. a first-ever `createBackup()` racing `getOrCreateBackupKey`, or
 * two `restoreBackup()` calls racing the crash-recovery marker file) must never actually run
 * concurrently within one process. This proves the primitive itself serializes — the fact that
 * `src/backup/http.ts`/`rotation.ts`/`desktop/database.ts` each wrap their real calls in it is
 * verified by the existing backup-ipc/backup-create/backup-restore suites still passing
 * unmodified after the wiring.
 */
describe('withBackupLock', () => {
  it('never runs two callers concurrently — the second only starts after the first settles', async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    async function op(name: string, delayMs: number): Promise<void> {
      return withBackupLock(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        events.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        events.push(`${name}:end`);
        active--;
      });
    }

    // Fire three "concurrent" callers — a slow first call must not let the later ones interleave.
    const all = Promise.all([op('a', 30), op('b', 5), op('c', 5)]);
    await all;

    expect(maxActive).toBe(1);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('a caller that throws does not block later callers, and its own rejection still reaches the caller', async () => {
    const events: string[] = [];

    const failing = withBackupLock(async () => {
      events.push('failing:start');
      throw new Error('simulated backup failure');
    });
    await expect(failing).rejects.toThrow('simulated backup failure');

    await withBackupLock(async () => {
      events.push('after-failure:ran');
    });

    expect(events).toEqual(['failing:start', 'after-failure:ran']);
  });

  it('two racing "first key creation" style callers are fully serialized, not interleaved even at the microtask level', async () => {
    // Models the exact TOCTOU shape of getOrCreateBackupKey: read a shared "key" variable, and
    // only write it if it was still unset — WITHOUT the lock this is racy; WITH it, the second
    // caller always observes the first caller's write.
    let sharedKey: string | null = null;
    const winners: string[] = [];

    async function getOrCreateKey(name: string): Promise<string> {
      return withBackupLock(async () => {
        const existing = sharedKey;
        await Promise.resolve(); // yield a microtask, same shape as an async secretStore.get()
        if (existing !== null) return existing;
        const minted = `key-from-${name}`;
        sharedKey = minted;
        winners.push(name);
        return minted;
      });
    }

    const [keyA, keyB] = await Promise.all([getOrCreateKey('nightly'), getOrCreateKey('manual-click')]);

    expect(keyA).toBe(keyB); // both callers must resolve to the SAME key
    expect(winners).toHaveLength(1); // only one caller actually minted a key
  });
});
