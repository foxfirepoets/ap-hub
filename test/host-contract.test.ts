import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { isAbsolute } from 'node:path';
import { createHostAdapter, detectOs, type HostAdapter } from '../src/host/index.js';
import type { CredentialTarget } from '../src/host/types.js';

/**
 * HostAdapter contract suite (CHUNK_7, ARCHITECTURE §3). Runs against whichever adapter
 * is present for the current OS. On Windows (the Phase-1A reference host, incl. this VPS)
 * it exercises real DPAPI + real port probing; on other OSes the suite is skipped (macOS
 * is exercised on a real Mac in Phase 1B). The suite defines what "a working host" means.
 */

const os = detectOs();
const runHere = os === 'windows'; // this pilot's reference OS
const d = runHere ? describe : describe.skip;

d(`HostAdapter contract — ${os}`, () => {
  const host: HostAdapter = createHostAdapter();
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it('dataDir()/logDir() are absolute and user-scoped', () => {
    expect(isAbsolute(host.dataDir())).toBe(true);
    expect(host.dataDir()).toMatch(/APHub$/);
    expect(host.logDir().startsWith(host.dataDir())).toBe(true);
  });

  it('secretStore round-trips a Generic Credential and absent delete is idempotent', async () => {
    const install = `contract-${Date.now()}`;
    const name = `APHub/${install}/roundtrip` as CredentialTarget;
    const secret = 'aph_secret_value_' + Math.random().toString(36).slice(2);
    try {
      await host.secretStore.put(name, secret);
      expect(await host.secretStore.get(name)).toBe(secret);
      expect(await host.secretStore.listTargets?.(`APHub/${install}/`)).toContain(name);
    } finally {
      await host.secretStore.delete(name);
      await host.secretStore.delete(name);
    }
    expect(await host.secretStore.get(name)).toBeNull();
  }, 30_000);

  it('secretStore rejects non-APHub and malformed targets before invoking the OS', async () => {
    await expect(host.secretStore.put('OtherApp/install/key' as CredentialTarget, 'never-written'))
      .rejects.toThrow('INVALID_CREDENTIAL_TARGET');
    await expect(host.secretStore.get('APHub/../key' as CredentialTarget))
      .rejects.toThrow('INVALID_CREDENTIAL_TARGET');
  });

  it('probePort reports a known-occupied port with a PID, and a free port as free', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    servers.push(server);
    const port: number = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    const occupied = await host.probePort(port);
    expect(occupied.free).toBe(false);
    expect(occupied.pid).toBe(process.pid);

    server.close();
    await new Promise((r) => setTimeout(r, 200));
    const freed = await host.probePort(port);
    expect(freed.free).toBe(true);
  }, 30_000);

  it('spawnChild launches a process and reports its exit', async () => {
    const handle = host.spawnChild({ command: process.execPath, args: ['-e', 'process.exit(0)'], label: 'probe' });
    expect(handle.label).toBe('probe');
    const code: number | null = await new Promise((resolve) => handle.onExit(resolve));
    expect(code).toBe(0);
  }, 15_000);
});

// Type-level guarantee that the macOS adapter is present and compiles (Phase 1B exercises it).
it('macOS adapter is importable and type-checks (compiled in 1A, exercised in 1B)', async () => {
  const mod = await import('../src/host/macos.js');
  expect(typeof mod.createMacosHostAdapter).toBe('function');
});
