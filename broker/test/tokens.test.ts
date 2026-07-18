import { describe, it, expect, afterAll } from 'vitest';
import { query, closePool } from '../src/db.js';
import { generateToken, hashToken, constantTimeEqual, looksLikeToken, TOKEN_PREFIX } from '../src/tokens.js';
import { seedInstall } from './helpers.js';

describe('install tokens', () => {
  afterAll(closePool);

  it('generates a 32-byte base64url token prefixed aph_', () => {
    const t = generateToken();
    expect(t.startsWith(TOKEN_PREFIX)).toBe(true);
    const body = t.slice(TOKEN_PREFIX.length);
    // 32 bytes base64url → 43 chars, no padding, url-safe alphabet only.
    expect(body).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(looksLikeToken(t)).toBe(true);
    expect(looksLikeToken('nope')).toBe(false);
  });

  it('round-trip: only the SHA-256 is stored; the plaintext never lands in the DB', async () => {
    const { token, id } = await seedInstall();
    const { rows } = await query<{ token_sha256: string }>(
      'SELECT token_sha256 FROM installs WHERE id=$1',
      [id],
    );
    const stored = rows[0]!.token_sha256;
    expect(stored).toBe(hashToken(token));
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(TOKEN_PREFIX);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);

    // Belt-and-braces: the raw token appears nowhere in the installs table.
    const { rows: hits } = await query<{ n: string }>(
      'SELECT count(*) AS n FROM installs WHERE label = $1 OR token_sha256 = $1',
      [token],
    );
    expect(Number(hits[0]!.n)).toBe(0);
  });

  it('constant-time compare matches equal digests and rejects unequal / mismatched-length', () => {
    const a = hashToken('x');
    expect(constantTimeEqual(a, a)).toBe(true);
    expect(constantTimeEqual(a, hashToken('y'))).toBe(false);
    expect(constantTimeEqual(a, a.slice(0, 10))).toBe(false); // length mismatch → false, no throw
  });
});
