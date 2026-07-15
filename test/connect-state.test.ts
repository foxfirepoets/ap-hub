import { describe, it, expect } from 'vitest';
import { signConnectState, verifyConnectState } from '../src/auth/connect-state.js';
import { resetConfigCache } from '../src/config.js';

describe('connect-state', () => {
  it('round-trips: sign for a tenant, verify immediately, get that tenant id back', () => {
    const token = signConnectState(7);
    expect(verifyConnectState(token)).toEqual({ tenantId: 7 });
  });

  it('rejects a tampered token (one flipped character)', () => {
    const token = signConnectState(7);
    const flipped = token.at(-1) === 'a' ? token.slice(0, -1) + 'b' : token.slice(0, -1) + 'a';
    expect(verifyConnectState(flipped)).toBeNull();
  });

  it('accepts a token checked at exactly 4:59 after signing, rejects at 5:01', () => {
    const signedAt = 1_000_000;
    const token = signConnectState(7, () => signedAt);

    const at459Later = () => signedAt + (4 * 60 + 59) * 1000; // 4 min 59 s later
    expect(verifyConnectState(token, at459Later)).toEqual({ tenantId: 7 });

    const at501Later = () => signedAt + (5 * 60 + 1) * 1000; // 5 min 1 s later
    expect(verifyConnectState(token, at501Later)).toBeNull();
  });

  it('rejects a token signed then verified with a different SESSION_COOKIE_SECRET', () => {
    const original = process.env.SESSION_COOKIE_SECRET;
    try {
      process.env.SESSION_COOKIE_SECRET = 'secret-A';
      resetConfigCache();
      const token = signConnectState(7);

      process.env.SESSION_COOKIE_SECRET = 'secret-B';
      resetConfigCache();
      expect(verifyConnectState(token)).toBeNull();
    } finally {
      process.env.SESSION_COOKIE_SECRET = original;
      resetConfigCache();
    }
  });
});
