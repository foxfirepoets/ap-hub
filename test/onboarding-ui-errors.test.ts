import { describe, it, expect } from 'vitest';
import { friendlyOnboardingError } from '../app/lib/onboardingErrors.js';

// CHUNK_1_ERRORHELPERS — pure onboarding error-code → plain-English mapper.
// No DB/DOM/React involved; covers the 4 named codes + one unrecognized code.

describe('friendlyOnboardingError', () => {
  it('VALIDATION: distinct, non-raw-code text, retryable', () => {
    const r = friendlyOnboardingError('VALIDATION', 'raw message');
    expect(r.text).not.toBe('VALIDATION');
    expect(r.text).not.toContain('VALIDATION');
    expect(r.retryable).toBe(true);
  });

  it('FORBIDDEN: distinct, non-raw-code text, not retryable', () => {
    const r = friendlyOnboardingError('FORBIDDEN', 'raw message');
    expect(r.text).not.toBe('FORBIDDEN');
    expect(r.text).not.toContain('FORBIDDEN');
    expect(r.retryable).toBe(false);
  });

  it('UNAUTHENTICATED: distinct, non-raw-code text, not retryable', () => {
    const r = friendlyOnboardingError('UNAUTHENTICATED', 'raw message');
    expect(r.text).not.toBe('UNAUTHENTICATED');
    expect(r.text).not.toContain('UNAUTHENTICATED');
    expect(r.retryable).toBe(false);
  });

  it('DRY_RUN_LOCKED: distinct, non-raw-code text, retryable', () => {
    const r = friendlyOnboardingError('DRY_RUN_LOCKED', 'raw message');
    expect(r.text).not.toBe('DRY_RUN_LOCKED');
    expect(r.text).not.toContain('DRY_RUN_LOCKED');
    expect(r.retryable).toBe(true);
  });

  it('no two recognized codes produce identical text', () => {
    const codes = ['VALIDATION', 'FORBIDDEN', 'UNAUTHENTICATED', 'DRY_RUN_LOCKED'];
    const texts = codes.map((c) => friendlyOnboardingError(c, 'raw message').text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('unrecognized code: generic fallback that still includes fallbackMessage, retryable', () => {
    const r = friendlyOnboardingError('SOME_UNKNOWN_CODE', 'the original raw error text');
    expect(r.text).toContain('the original raw error text');
    expect(r.text).not.toBe('SOME_UNKNOWN_CODE');
    expect(r.retryable).toBe(true);
  });
});
