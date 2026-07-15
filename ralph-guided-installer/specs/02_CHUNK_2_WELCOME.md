# CHUNK_2_WELCOME: Welcome overlay naming both onboarding prerequisites

## Summary

Adds a non-persisted welcome overlay shown before any onboarding step content renders. It names both prerequisites (Gmail access, a QuickBooks sandbox company) and reveals the existing step flow (starting at whatever `state.step` the backend already reports — never resets progress) once dismissed via "Get Started." Renders strictly after the existing non-owner gate, so a bookkeeper/CPA never sees it. No backend call, no new data — reuses the `OnboardingState` this page already fetches.

## Acceptance Criteria

- [ ] On first render of `/onboarding` (owner role), the welcome overlay is visible and step content (e.g. the "Connect Gmail" button) is not.
- [ ] The overlay text names both "Gmail" and "QuickBooks" (or "QBO"/"QuickBooks Online").
- [ ] Clicking "Get Started" dismisses the overlay and reveals the step flow at the backend-reported `state.step` (not forced back to `connect_gmail`).
- [ ] Non-owner roles never see the overlay — the existing "Only the account owner can complete setup" message still renders first.
- [ ] The overlay's dismissed state does not persist across a full page reload (re-appears on reload — by design, not a bug).
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No HTTP endpoints — reuses the existing `GET /api/onboarding` call this page already makes; no new fetch.

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: owner lands on the page, overlay shows both prerequisites, "Get Started" reveals step 1.
- **Edge case**: a returning owner whose `state.step` is already `dry_run` — dismissing the overlay reveals `dry_run`, not `connect_gmail`.
- **Failure case**: N/A — no network/mutating call is introduced by this chunk.
- **Integration**: this overlay wraps the EXISTING step-rendering code from CHUNK_6_ONBOARDING unchanged; CHUNK_3's stepper renders alongside/after it once dismissed.

## Dependencies

- **Requires**: None (independent of CHUNK_1).
- **Blocks**: None directly, but CHUNK_5's final gate verifies this chunk alongside the others.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_2_WELCOME</promise>
