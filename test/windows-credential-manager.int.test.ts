import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WindowsCredentialManagerSecretStore } from '../src/host/windows.js';
import type { CredentialTarget } from '../src/host/types.js';

const windowsOnly = process.platform === 'win32' ? describe : describe.skip;

windowsOnly('Windows Credential Manager integration', () => {
  it('preserves exact UTF-8 boundaries and keeps failures value-free', async () => {
    const store = new WindowsCredentialManagerSecretStore();
    const install = `int-${process.pid}-${randomBytes(5).toString('hex')}`;
    const targets: CredentialTarget[] = [];
    const target = (name: string): CredentialTarget => {
      const value = `APHub/${install}/${name}` as CredentialTarget;
      targets.push(value);
      return value;
    };
    const roundTrips: Array<[CredentialTarget, string]> = [
      [target('ascii-limit'), 'a'.repeat(2560)],
      [target('unicode-limit'), 'é'.repeat(1280)],
      [target('mixed-emoji'), `${'🙂'.repeat(639)}abc`],
      [target('json-injection'), 'é"; $(Write-Output injected) `n ☃\n終'],
    ];
    const oversized = [
      [target('ascii-over'), 'x'.repeat(2561)],
      [target('unicode-over'), `${'é'.repeat(1280)}a`],
      [target('emoji-over'), `${'🙂'.repeat(640)}a`],
    ] as const;

    try {
      for (const [credentialTarget, value] of roundTrips) {
        expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(2560);
        await store.put(credentialTarget, value);
        expect(await store.get(credentialTarget)).toBe(value);
      }
      expect(await store.listTargets(`APHub/${install}/`)).toEqual(
        expect.arrayContaining(roundTrips.map(([credentialTarget]) => credentialTarget)),
      );

      for (const [credentialTarget, value] of oversized) {
        expect(Buffer.byteLength(value, 'utf8')).toBeGreaterThan(2560);
        const failure = await store.put(credentialTarget, value).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(/^WINDOWS_CREDENTIAL_MANAGER_FAILED:\d+$/);
        expect((failure as Error).message).not.toContain(value.slice(0, 32));
        expect(await store.get(credentialTarget)).toBeNull();
      }
    } finally {
      await Promise.all(targets.map(async (credentialTarget) => {
        await store.delete(credentialTarget);
        await store.delete(credentialTarget);
      }));
    }
    await Promise.all(targets.map(async (credentialTarget) => {
      expect(await store.get(credentialTarget)).toBeNull();
    }));
  }, 120_000);
});
