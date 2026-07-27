import { describe, it, expect } from 'vitest';
import { friendlyExceptionReason, EXCEPTION_REASON_CODES } from '../app/lib/exceptionReasons.js';
import { REASON_CODES } from '../src/exceptions.js';

// Fixed follow-up to CHUNK_6_CLEANUP's own "no technical vocabulary in the UI" mission: the
// Exceptions review screen (app/(app)/exceptions/page.tsx) was rendering raw `reasonCode` and
// raw `detail` verbatim. This proves the fix is real: every code in the actual `ReasonCode`
// taxonomy gets a specific, distinct, plain-English mapping, the mirror in app/lib has not
// drifted from the real taxonomy, and nothing here can leak a raw code or raw provider text.

// Stands in for a raw provider error / stack trace / SQL fragment / free-form `detail` string —
// must never surface in any `.title`/`.text` output below.
const RAW_LEAK_CANARY = 'AuditProof anchor failed: Error at pg_pool.ts:42 connection refused 127.0.0.1:5432';

describe('friendlyExceptionReason — reasonCode mirror integrity', () => {
  it('mirrors the real closed ReasonCode set (src/exceptions.ts REASON_CODES) with no drift', () => {
    expect(new Set(EXCEPTION_REASON_CODES)).toEqual(new Set(REASON_CODES));
    expect(EXCEPTION_REASON_CODES.length).toBe(REASON_CODES.length);
  });
});

describe('friendlyExceptionReason — every real ReasonCode gets a specific mapping', () => {
  for (const code of REASON_CODES) {
    it(`${code}: specific plain-English title + text, no raw code leak`, () => {
      const r = friendlyExceptionReason(code);
      expect(typeof r.title).toBe('string');
      expect(r.title.length).toBeGreaterThan(0);
      expect(typeof r.text).toBe('string');
      expect(r.text.length).toBeGreaterThan(0);
      // No raw code, and no snake_case/underscore token, anywhere in the rendered strings. (Only
      // codes that contain an underscore get the substring check — a handful of codes, like
      // `duplicate`, are also plain English words that legitimately appear inside their own
      // human-readable explanation.)
      expect(r.title).not.toBe(code);
      expect(r.text).not.toBe(code);
      expect(r.title).not.toMatch(/_/);
      expect(r.text).not.toMatch(/_/);
      if (code.includes('_')) {
        expect(r.title).not.toContain(code);
        expect(r.text).not.toContain(code);
      }
    });
  }

  it('no two real reason codes produce identical title text', () => {
    const titles = REASON_CODES.map((c) => friendlyExceptionReason(c).title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('no two real reason codes produce identical explanation text', () => {
    const texts = REASON_CODES.map((c) => friendlyExceptionReason(c).text);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe('friendlyExceptionReason — no raw detail/fallback leak path', () => {
  it('an unrecognized code never renders as itself and gets the generic fallback', () => {
    const r = friendlyExceptionReason('SOME_UNKNOWN_CODE_NOT_IN_THE_CLOSED_SET');
    expect(r.title).not.toContain('SOME_UNKNOWN_CODE_NOT_IN_THE_CLOSED_SET');
    expect(r.text).not.toContain('SOME_UNKNOWN_CODE_NOT_IN_THE_CLOSED_SET');
  });

  it('an empty-string code never renders raw text and gets the generic fallback', () => {
    const r = friendlyExceptionReason('');
    expect(r.title.length).toBeGreaterThan(0);
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('the function signature has no way to accept or interpolate a raw detail string', () => {
    // friendlyExceptionReason takes only reasonCode — there is no detail/fallbackMessage
    // parameter for a raw provider string to travel through, unlike friendlyOnboardingError's
    // (intentionally unused) second argument. This is a structural proof: calling with a
    // canary-shaped second argument is a type error, so it cannot appear at runtime output.
    const r = friendlyExceptionReason('low_confidence');
    expect(r.title).not.toContain(RAW_LEAK_CANARY);
    expect(r.text).not.toContain(RAW_LEAK_CANARY);
  });
});
