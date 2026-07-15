# CHUNK_1_ERRORHELPERS: Extract a pure, testable error-code-to-plain-English mapper for the onboarding wizard

## Summary

The onboarding page currently shows raw error codes/messages on failure. This chunk extracts a pure function, `friendlyOnboardingError`, that maps known error codes (`VALIDATION`, `FORBIDDEN`, `UNAUTHENTICATED`, `DRY_RUN_LOCKED`, unrecognized) to plain-English text plus a `retryable` flag — with no DOM/React dependency, so it is directly unit-testable under the existing `npm test` gate. This is the foundation every later chunk's failure panel calls into; it hands off a stable, tested function signature to CHUNK_5.

## Acceptance Criteria

- [ ] `friendlyOnboardingError(code: string, fallbackMessage: string): { text: string; retryable: boolean }` exists in `app/lib/onboardingErrors.ts`.
- [ ] `VALIDATION` → distinct plain-English text, `retryable: true`.
- [ ] `FORBIDDEN` → distinct plain-English text, `retryable: false`.
- [ ] `UNAUTHENTICATED` → distinct plain-English text, `retryable: false`.
- [ ] `DRY_RUN_LOCKED` → distinct plain-English text, `retryable: true`.
- [ ] An unrecognized code → generic fallback text that still includes `fallbackMessage` (never silently drops the original message), `retryable: true`.
- [ ] No two recognized codes produce identical `text`.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No HTTP endpoints — internal presentational helper only.

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: each of the 4 named codes returns its own distinct, non-raw-code text.
- **Edge case**: an unrecognized code falls back to generic text while still surfacing `fallbackMessage` (e.g. in a "Details" field), never an empty string.
- **Failure case**: N/A — this is a pure function with no I/O; there is no failure mode to test beyond input coverage.
- **Integration**: CHUNK_5 imports this function directly and asserts its output appears in the rendered failure panel.

## Dependencies

- **Requires**: None (first chunk).
- **Blocks**: CHUNK_5_INTEGRATION (consumes this function).

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_1_ERRORHELPERS</promise>
