import { describe, it, expect, vi } from 'vitest';
import { sendHeartbeat } from '../src/telemetry.js';

/**
 * CHUNK_6 hosted-dependency removal: telemetry is local-only — there is no
 * hosted broker to heartbeat. sendHeartbeat must never make a network call and
 * must always resolve false.
 */

describe('sendHeartbeat (local-only no-op)', () => {
  it('never calls fetch and resolves false', async () => {
    const fetchImpl = vi.fn();
    const ok = await sendHeartbeat({ event: 'alive', pgOk: true, detail: 'boot:ok' }, { fetchImpl: fetchImpl as any });
    expect(ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves false for every event kind, still without calling fetch', async () => {
    const fetchImpl = vi.fn();
    for (const event of ['alive', 'watchdog_restart', 'pg_health', 'shutdown'] as const) {
      await expect(sendHeartbeat({ event }, { fetchImpl: fetchImpl as any })).resolves.toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
