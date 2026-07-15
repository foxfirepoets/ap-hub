# CHUNK_5_INTEGRATION: Wire the friendly failure panel into every existing failure path, final gate

## Summary

Wires `friendlyOnboardingError` (CHUNK_1) into every existing failure path on the onboarding page (`goStep`, `runDryRun`, `approveRule`), replacing the raw `notice.kind === 'bad'` text with the mapped plain-English text, a "Try again" action for retryable codes, and a collapsed "Details" disclosure carrying the original raw message (never fully hidden). This is the final chunk — it also re-runs the full repo validation gate and confirms zero backend/schema drift, closing out the feature.

## Acceptance Criteria

- [ ] `goStep`, `runDryRun`, and `approveRule`'s failure paths all render through `friendlyOnboardingError` instead of the raw `res.error?.message`.
- [ ] A `VALIDATION`, `FORBIDDEN`, `UNAUTHENTICATED`, and an unrecognized code each produce visibly distinct panel text (per CHUNK_1's mapping) somewhere in the rendered failure UI.
- [ ] Retryable failures show a "Try again" action that re-issues the same failed action; non-retryable failures (`FORBIDDEN`, `UNAUTHENTICATED`) do not show "Try again".
- [ ] The raw original message is still present (in a collapsed "Details" disclosure), never fully discarded.
- [ ] `git diff` on `src/services/onboarding.ts`, `app/api/onboarding/**`, and `migrations/**` is empty (this chunk, and the whole feature, touches no backend file).
- [ ] `npm run web:build` compiles with 25 routes (unchanged route count).
- [ ] `npx vitest run test/onboarding.test.ts` passes unmodified (11 tests, service/action layer — proves no backend contract broke).
- [ ] The full repo gate `npm run lint && npm run typecheck && npm test && npm run web:build` exits 0.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No HTTP endpoints — wires existing client-side calls to the existing 3 onboarding API routes; no new route.

## Database Changes

No schema changes in this chunk (or anywhere in this feature).

## Test Scenarios

- **Happy path**: a `VALIDATION` response from `goStep` renders the mapped text + "Try again"; clicking it re-calls `goStep` with the same arguments.
- **Edge case**: an unrecognized error code still shows a usable panel (generic text + raw details), never a blank/broken UI.
- **Failure case**: a `FORBIDDEN` response shows the mapped text with no retry action (retrying won't help a non-owner).
- **Integration**: this chunk is the integration point for CHUNK_1 (the mapper) with CHUNK_2/3/4 (the surrounding graphical shell) — after this chunk, the full spec's acceptance criteria (SPEC-guided-onboarding-installer.md §3) all hold simultaneously.

## Dependencies

- **Requires**: CHUNK_1_ERRORHELPERS (the mapper function), CHUNK_2_WELCOME, CHUNK_3_STEPPER, CHUNK_4_EXPLAINERS (all rendered on the same page this chunk wires failures into).
- **Blocks**: None (final chunk).

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_5_INTEGRATION</promise>
