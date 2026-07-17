# CHUNK_1_BASELINE: Establish the green baseline and fix the OAuth port drift

## Summary

Prove the repo is green before any change, so every later chunk has a fixed reference. Records the true test count (212), confirms the full gate passes, and corrects the stale `.env.example` OAuth ports (3000→3001) that would otherwise misdirect Google/Intuit callbacks. First because nothing else may claim "tests still pass" against an unverified baseline.

## Acceptance Criteria

- [ ] `DATABASE_URL=postgres://aphub:aphub@127.0.0.1:5432/aphub npm test` reports **212 passed** across 28 files.
- [ ] `npm run lint`, `npm run typecheck`, `npm run web:build` all exit 0 (web:build = 25 routes).
- [ ] `.env.example` lines for `GMAIL_REDIRECT_URI`, `QBO_SANDBOX_REDIRECT_URI`, and `PORT` read `3001` (not `3000`), matching `src/config.ts` defaults.
- [ ] `.ralph/state.md` records the baseline count `212` as the immutable floor.
- [ ] No source or test file is modified except `.env.example`.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No HTTP endpoints — baseline verification + config-doc fix only.

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: full gate runs green at 212 tests.
- **Edge case**: tests run with `DATABASE_URL` on 5432 (vitest does not load `.env`; `test/setup.ts:9` falls back to closed 5433 without the override).
- **Failure case**: if the count is below 212, STOP — the environment or DB is wrong; do not proceed.
- **Integration**: the recorded 212 floor is the pass/fail reference every subsequent chunk compares against.

## Dependencies

- **Requires**: None
- **Blocks**: CHUNK_2_BROKERAUTH (and all others)

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_1_BASELINE</promise>
