import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendHeartbeat } from '../src/telemetry.js';
import { resetConfigCache } from '../src/config.js';

/**
 * CHUNK_6 client telemetry: a heartbeat send is fully fail-safe — a broker error or a
 * network failure is logged and dropped, NEVER thrown, so the pipeline can never crash
 * on telemetry. Only sends when a broker is configured.
 */

const BROKER = 'http://127.0.0.1:9';

describe('sendHeartbeat (client, fail-safe)', () => {
  beforeEach(() => {
    resetConfigCache();
    process.env.BROKER_BASE_URL = BROKER;
    process.env.BROKER_INSTALL_TOKEN = 'aph_testtoken';
  });

  it('posts to the broker /v1/heartbeat with the install token and returns true on 201', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    const ok = await sendHeartbeat({ event: 'alive', pgOk: true, detail: 'boot:ok' }, { fetchImpl: fetchImpl as any });
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BROKER}/v1/heartbeat`);
    expect((opts as any).headers.authorization).toBe('Bearer aph_testtoken');
    expect(JSON.parse((opts as any).body)).toMatchObject({ event: 'alive', pg_ok: true, detail: 'boot:ok' });
  });

  it('a broker rejection (non-2xx) is dropped and returns false — never throws', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(sendHeartbeat({ event: 'alive' }, { fetchImpl: fetchImpl as any })).resolves.toBe(false);
  });

  it('a network failure is swallowed and returns false — never throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(sendHeartbeat({ event: 'watchdog_restart' }, { fetchImpl: fetchImpl as any })).resolves.toBe(false);
  });

  it('is a no-op (false, no fetch) when no broker is configured (direct mode)', async () => {
    resetConfigCache();
    delete process.env.BROKER_BASE_URL;
    process.env.BROKER_INSTALL_TOKEN = '';
    const fetchImpl = vi.fn();
    const ok = await sendHeartbeat({ event: 'alive' }, { fetchImpl: fetchImpl as any });
    expect(ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
