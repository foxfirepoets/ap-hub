import { describe, it, expect } from 'vitest';
import { friendlyOnboardingError, ONBOARDING_ERROR_CODES } from '../app/lib/onboardingErrors.js';
import { IPC_ERROR_CODES } from '../desktop/ipc/errors.js';

// CHUNK_6_CLEANUP — proves the raw fallback leak in `friendlyOnboardingError`'s old `default`
// branch (`Something went wrong on that step. Details: ${fallbackMessage}`) is gone, and stays
// gone: every code the IPC layer can actually hand to the renderer gets a specific,
// non-generic, plain-English mapping, and nothing reaches the UI by interpolating the raw
// `fallbackMessage` argument. `mapKnownCode`'s exhaustive switch (a `never`-typed default) is
// the build-time half of this proof — `npx tsc --noEmit` fails if `desktop/ipc/errors.ts` ever
// adds a code without a matching case in `app/lib/onboardingErrors.ts`. This file is the
// runtime half.

// A raw string that must never surface in any `.text` output below — stands in for a stack
// trace, a provider error, a SQL fragment, or any other technical detail the non-technical user
// must never see (CLAUDE.md, .ralph/guardrails.md).
const RAW_LEAK_CANARY = 'raw_leak_canary: Error at pg_pool.ts:42 connection refused 127.0.0.1:5432';

describe('friendlyOnboardingError — no raw fallback path', () => {
  it("mirrors the real closed IPC error-code set (desktop/ipc/errors.ts) with no drift", () => {
    expect(new Set(ONBOARDING_ERROR_CODES)).toEqual(new Set(IPC_ERROR_CODES));
    expect(ONBOARDING_ERROR_CODES.length).toBe(IPC_ERROR_CODES.length);
  });

  it('every real IPC error code maps to a specific, plain-English, non-raw sentence', () => {
    for (const code of IPC_ERROR_CODES) {
      const r = friendlyOnboardingError(code, RAW_LEAK_CANARY);
      expect(typeof r.text).toBe('string');
      expect(r.text.length).toBeGreaterThan(0);
      expect(r.text).not.toBe(code);
      expect(r.text).not.toContain(code);
      expect(r.text).not.toContain(RAW_LEAK_CANARY);
      expect(r.text).not.toContain('Details:');
      expect(typeof r.retryable).toBe('boolean');
    }
  });

  it('no two real error codes produce identical text', () => {
    const texts = IPC_ERROR_CODES.map((c) => friendlyOnboardingError(c, RAW_LEAK_CANARY).text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('DRY_RUN_LOCKED cannot arrive as its own code (normalizeCode maps it to FORBIDDEN) and, if it', () => {
    // ever did reach this function directly, still gets safe generic text rather than a leak.
    const r = friendlyOnboardingError('DRY_RUN_LOCKED', RAW_LEAK_CANARY);
    expect(r.text).not.toContain(RAW_LEAK_CANARY);
    expect(r.text).not.toBe('DRY_RUN_LOCKED');
  });

  it('an unrecognized code never renders the raw fallbackMessage, the code, or "Details:"', () => {
    const r = friendlyOnboardingError('SOME_UNKNOWN_CODE_NOT_IN_THE_CLOSED_SET', RAW_LEAK_CANARY);
    expect(r.text).not.toContain(RAW_LEAK_CANARY);
    expect(r.text).not.toContain('SOME_UNKNOWN_CODE_NOT_IN_THE_CLOSED_SET');
    expect(r.text).not.toContain('Details:');
    expect(typeof r.retryable).toBe('boolean');
  });

  it('an empty-string code (the ?? "" call-site fallback) never renders the raw fallbackMessage', () => {
    const r = friendlyOnboardingError('', RAW_LEAK_CANARY);
    expect(r.text).not.toContain(RAW_LEAK_CANARY);
    expect(r.text).not.toContain('Details:');
  });
});
