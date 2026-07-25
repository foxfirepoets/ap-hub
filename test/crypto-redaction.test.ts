import { describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  sha256Hex,
  secretMaterialEqual,
  verifySecretMaterial,
} from '../src/crypto.js';
import { redact, redactString } from '../src/logger.js';

const KEY = 'a'.repeat(64);

describe('crypto', () => {
  it('round-trips AES-256-GCM', () => {
    const ct = encrypt('super-secret-token', KEY);
    expect(ct).not.toContain('super-secret-token');
    expect(decrypt(ct, KEY)).toBe('super-secret-token');
  });
  it('rejects a wrong-length key', () => {
    expect(() => encrypt('x', 'short')).toThrow(/32 bytes/);
  });
  it('hashes deterministically', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex(Buffer.from('abc')));
  });
  it('verifies exact UTF-8 bytes plus an authenticated encryption round trip', () => {
    expect(secretMaterialEqual('päss🔐', 'päss🔐')).toBe(true);
    expect(secretMaterialEqual('päss🔐', 'päss')).toBe(false);
    expect(verifySecretMaterial('token-material', 'token-material')).toBe(true);
    expect(verifySecretMaterial('token-material', 'token-material ')).toBe(false);
  });
});

describe('redaction (secrets/PII log assertion)', () => {
  it('redacts ssk_ keys, telegram tokens, and bearer tokens in strings', () => {
    expect(redactString('key=ssk_live_abc123XYZ end')).toContain('[REDACTED]');
    expect(redactString('authorization: Bearer eyJabc.def.ghi')).toContain('[REDACTED]');
    expect(redactString('bot 123456789:AAExampleTelegramTokenValue1234567890')).toContain('[REDACTED]');
  });
  it('redacts sensitive object keys (bank / tokens)', () => {
    const out = redact({
      vendor: 'Acme',
      bank_info: '123456789',
      access_token: 'secret',
      swarmsync_api_key: 'ssk_live_zzz',
      nested: { refresh_token: 'r', amount: 100 },
    }) as any;
    expect(out.vendor).toBe('Acme');
    expect(out.bank_info).toBe('[REDACTED]');
    expect(out.access_token).toBe('[REDACTED]');
    expect(out.swarmsync_api_key).toBe('[REDACTED]');
    expect(out.nested.refresh_token).toBe('[REDACTED]');
    expect(out.nested.amount).toBe(100);
  });
});
