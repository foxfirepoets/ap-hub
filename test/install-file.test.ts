import { describe, it, expect } from 'vitest';
import {
  parseInstallFile,
  serializeInstallFile,
  isCredentialShapedKey,
  isCredentialShapedValue,
  InstallFileInvalid,
  type InstallFile,
} from '../src/install/install-file.js';

/**
 * CHUNK_2/CHUNK_4 — install.json must never carry a secret. Enforced at LOAD, not only at
 * write, because the threat is a file that arrived some other way: hand-edited, restored from
 * an old backup, or written by a version that was less careful.
 */

const VALID: InstallFile = {
  installId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  osAccountId: 'S-1-5-21-1004336348-1177238915-682003330-1001',
  platform: 'win32',
  appVersion: '0.1.0',
  dbPort: 55433,
  dataDir: 'C:\\Users\\owner\\AppData\\Local\\APHub\\data',
  logDir: 'C:\\Users\\owner\\AppData\\Local\\APHub\\logs',
};

describe('install.json accepts the documented non-secret shape', () => {
  it('round-trips a valid file', () => {
    expect(parseInstallFile(serializeInstallFile(VALID))).toEqual(VALID);
  });

  it('accepts the spec §6 example port range boundaries', () => {
    expect(parseInstallFile(serializeInstallFile({ ...VALID, dbPort: 1024 })).dbPort).toBe(1024);
    expect(parseInstallFile(serializeInstallFile({ ...VALID, dbPort: 65535 })).dbPort).toBe(65535);
  });

  it('does not mistake a SID, a UUID or a Windows path for a credential', () => {
    expect(isCredentialShapedValue(VALID.osAccountId)).toBe(false);
    expect(isCredentialShapedValue(VALID.installId)).toBe(false);
    expect(isCredentialShapedValue(VALID.dataDir)).toBe(false);
  });
});

describe('install.json rejects a port outside 1024-65535 (spec §6)', () => {
  it.each([1023, 0, -1, 65536, 70000])('rejects dbPort %i', (port) => {
    const raw = JSON.stringify({ ...VALID, dbPort: port });
    expect(() => parseInstallFile(raw)).toThrow(InstallFileInvalid);
  });

  it('rejects a non-integer port', () => {
    expect(() => parseInstallFile(JSON.stringify({ ...VALID, dbPort: 55433.5 }))).toThrow(InstallFileInvalid);
  });
});

describe('install.json rejects credential-shaped KEYS at any depth', () => {
  it.each([
    'token', 'secret', 'password', 'apiKey', 'api_key', 'API-KEY', 'clientSecret',
    'client_secret', 'refreshToken', 'privateKey', 'accessKey', 'passphrase', 'authorization',
  ])('rejects a top-level "%s" key', (key) => {
    const raw = JSON.stringify({ ...VALID, [key]: 'anything' });
    expect(() => parseInstallFile(raw)).toThrow(/credential-shaped key/);
  });

  it('rejects a credential key nested inside an object or an array', () => {
    expect(() => parseInstallFile(JSON.stringify({ ...VALID, extra: { deep: { apiKey: 'x' } } })))
      .toThrow(/credential-shaped key/);
    expect(() => parseInstallFile(JSON.stringify({ ...VALID, list: [{ ok: 1 }, { token: 'x' }] })))
      .toThrow(/credential-shaped key/);
  });

  it('collides separator and casing variants so none slips through', () => {
    for (const k of ['client-secret', 'client_secret', 'clientSecret', 'ClientSecret', 'CLIENT__SECRET']) {
      expect(isCredentialShapedKey(k)).toBe(true);
    }
  });
});

describe('install.json rejects credential-shaped VALUES under innocent keys', () => {
  it.each([
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'],
    ['a bearer header', 'Bearer abcdefghijklmnopqrstuvwxyz0123456789'],
    ['a PEM block', '-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----'],
    ['a Google OAuth token', 'ya29.a0AfH6SMBx7Yq2vK3nR8pL0wZ1cD4eF5gH6iJ7kL8mN9oP0qR'],
    ['a Google API key', 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY'],
    ['a Stripe-style key', 'sk_live_51H8xKzLkJ9mNpQrStUvWxYz0123456789abcdef'],
    ['a GitHub PAT', 'ghp_16C7e42F292c6912E7710c838347Ae178B4a'],
    ['a long high-entropy blob', 'Xk29fJ2mQp8vRt4nBw7cLz1yHs6dGe3aUi0oPl5MzTr9Nv2Kb8Xq4Wj7Fy'],
  ])('rejects %s stored under a harmless key', (_label, value) => {
    const raw = JSON.stringify({ ...VALID, note: value });
    expect(() => parseInstallFile(raw)).toThrow(InstallFileInvalid);
  });

  it('never echoes the offending value in the error, which would copy the secret into a log', () => {
    const secret = 'ya29.a0AfH6SMBx7Yq2vK3nR8pL0wZ1cD4eF5gH6iJ7kL8mN9oP0qR';
    try {
      parseInstallFile(JSON.stringify({ ...VALID, note: secret }));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
      expect((err as Error).message).toContain('note');
    }
  });
});

describe('install.json rejects unknown keys rather than ignoring them', () => {
  it('refuses an unrecognised key even when it looks harmless', () => {
    // Ignoring unknown keys would let a credential ride along untouched.
    expect(() => parseInstallFile(JSON.stringify({ ...VALID, colour: 'blue' }))).toThrow(InstallFileInvalid);
  });

  it('refuses malformed JSON and non-objects instead of guessing', () => {
    for (const raw of ['', '{', 'null', '[]', '"a string"', '42']) {
      expect(() => parseInstallFile(raw)).toThrow(InstallFileInvalid);
    }
  });
});

describe('install.json refuses to WRITE a secret even if a caller supplies one', () => {
  it('sweeps on the way out too', () => {
    const poisoned = { ...VALID, appVersion: 'ya29.a0AfH6SMBx7Yq2vK3nR8pL0wZ1cD4eF5gH6iJ7kL8m' };
    expect(() => serializeInstallFile(poisoned)).toThrow(/refusing to write/);
  });
});

describe('Version 1 is Windows only', () => {
  it('rejects a non-win32 platform', () => {
    expect(() => parseInstallFile(JSON.stringify({ ...VALID, platform: 'darwin' }))).toThrow(InstallFileInvalid);
    expect(() => parseInstallFile(JSON.stringify({ ...VALID, platform: 'linux' }))).toThrow(InstallFileInvalid);
  });
});
