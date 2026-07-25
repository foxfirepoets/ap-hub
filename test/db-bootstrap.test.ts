import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import {
  probeFreePort,
  isPortFree,
  PortRangeExhausted,
  PORT_PROBE_START,
  RESERVED_PORTS,
} from '../src/db/bootstrap.js';

/**
 * CHUNK_2_DATABASE — the bundled PostgreSQL must never collide with, connect to, or disturb a
 * PostgreSQL the user already runs. These tests hold real sockets open to prove the probe
 * steps over them, rather than mocking the answer it is supposed to discover.
 */

const held: Server[] = [];

function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.once('listening', () => {
      held.push(s);
      resolve();
    });
    s.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

afterEach(async () => {
  await Promise.all(held.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('port probing skips occupied ports (spec §3, §4)', () => {
  it('starts at 55432', () => {
    expect(PORT_PROBE_START).toBe(55432);
  });

  it('returns the start port when it is free', async () => {
    // Use an injected predicate so a genuinely busy 55432 on the dev machine cannot flake this.
    const port = await probeFreePort({ isFree: async () => true });
    expect(port).toBe(55432);
  });

  it('resolves upward past a real socket held on the start port', async () => {
    const base = 56100;
    await occupy(base);
    const port = await probeFreePort({ from: base });
    expect(port).toBeGreaterThan(base);
    expect(await isPortFree(port)).toBe(true);
  });

  it('resolves upward when several consecutive ports are held', async () => {
    const base = 56200;
    await occupy(base);
    await occupy(base + 1);
    await occupy(base + 2);
    const port = await probeFreePort({ from: base });
    expect(port).toBe(base + 3);
  });

  it('never returns 5432, even if the search would otherwise reach it', async () => {
    // Every port reports free; only the reserved-port rule can keep 5432 out of the result.
    const port = await probeFreePort({ from: 5432, isFree: async () => true });
    expect(port).toBe(5433);
    expect(RESERVED_PORTS).toContain(5432);
  });

  it('cannot reach 5432 from the real start port at all', async () => {
    const tried: number[] = [];
    await probeFreePort({
      isFree: async (p) => {
        tried.push(p);
        return p === PORT_PROBE_START + 5;
      },
    });
    expect(tried.every((p) => p > 5432)).toBe(true);
    expect(tried).not.toContain(5432);
  });

  it('is bounded and fails closed when no port is free', async () => {
    await expect(probeFreePort({ isFree: async () => false, maxAttempts: 8 })).rejects.toBeInstanceOf(
      PortRangeExhausted,
    );
  });

  it('reports exhaustion as DB_FAILED, the code the user-facing mapping expects', async () => {
    await probeFreePort({ isFree: async () => false, maxAttempts: 2 }).catch((err) => {
      expect((err as PortRangeExhausted).code).toBe('DB_FAILED');
      // The message never reaches the UI, but it must not carry anything but a port number.
      expect((err as Error).message).not.toMatch(/password|secret|token/i);
    });
    expect.assertions(2);
  });

  it('rejects a nonsensical start port instead of scanning', async () => {
    await expect(probeFreePort({ from: 80 })).rejects.toBeInstanceOf(RangeError);
    await expect(probeFreePort({ from: 70000 })).rejects.toBeInstanceOf(RangeError);
  });
});

describe('isPortFree observes real sockets', () => {
  it('reports a held port busy and a free port free', async () => {
    const base = 56300;
    expect(await isPortFree(base)).toBe(true);
    await occupy(base);
    expect(await isPortFree(base)).toBe(false);
  });

  it('binds only loopback while testing, never every interface', async () => {
    // If the probe bound 0.0.0.0, occupying 127.0.0.1 would not make it report busy.
    const base = 56400;
    await occupy(base);
    expect(await isPortFree(base)).toBe(false);
  });
});
