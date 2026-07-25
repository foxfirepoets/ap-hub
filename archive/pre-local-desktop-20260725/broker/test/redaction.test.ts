import { describe, it, expect } from 'vitest';
import { redact, redactString } from '../src/logger.js';
import { generateToken } from '../src/tokens.js';

/**
 * Log redaction: an `aph_` install token (and other upstream secrets) must never
 * render in a log line, whether it appears in a string or under a sensitive key.
 */

describe('broker log redaction', () => {
  it('redacts an aph_ token embedded in a string', () => {
    const token = generateToken();
    const line = `incoming request with Authorization: Bearer ${token} from install`;
    const out = redactString(line);
    expect(out).not.toContain(token);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts a bare aph_ token (no Bearer prefix)', () => {
    const token = generateToken();
    expect(redactString(`token=${token}`)).not.toContain(token);
  });

  it('redacts ssk_ and sk-ant upstream keys', () => {
    expect(redactString('key ssk_live_ABC123def')).not.toContain('ssk_live_ABC123def');
    expect(redactString('key sk-ant-api03-XYZ_123')).not.toContain('sk-ant-api03-XYZ_123');
  });

  it('redacts values under sensitive object keys', () => {
    const token = generateToken();
    const obj = redact({ authorization: `Bearer ${token}`, token_sha256: 'abc', nested: { token } }) as any;
    expect(obj.authorization).toBe('[REDACTED]');
    expect(obj.token_sha256).toBe('[REDACTED]');
    // nested aph_ string still gets pattern-redacted even under a non-sensitive key.
    expect(String(obj.nested.token)).not.toContain(token);
  });
});
