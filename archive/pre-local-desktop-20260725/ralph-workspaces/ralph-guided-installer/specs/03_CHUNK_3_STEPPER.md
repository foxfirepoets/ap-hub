# CHUNK_3_STEPPER: Visual progress stepper across all 9 onboarding steps

## Summary

Replaces the current plain "Step X of Y: Label" text line with a visual stepper showing all 9 existing `STEP_LABEL` entries, with completed / current / upcoming states visually distinguished. Purely presentational — reads the same `STEPS`/`STEP_LABEL` constants and `state.step` value the page already has; adds no new data source.

## Acceptance Criteria

- [ ] The stepper renders exactly 9 items, one per entry in the existing `STEP_LABEL` map.
- [ ] The item matching the current `state.step` carries a distinguishing attribute/class (e.g. `data-current="true"` or an `active` class) queryable in tests.
- [ ] Steps before the current one are marked completed (distinguishable attribute/class); steps after are upcoming.
- [ ] The stepper does not alter step navigation behavior — clicking a step label (if clickable) never skips validation or jumps ahead of the backend-reported step; if steps are not clickable, that's an acceptable, simpler choice (state this decision in the implementation).
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No HTTP endpoints — internal presentational component only.

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: `state.step === 'dry_run'` renders 4 completed steps, 1 current, 4 upcoming.
- **Edge case**: `state.step === 'connect_gmail'` (first step) renders 0 completed, 1 current, 8 upcoming.
- **Failure case**: N/A — pure rendering from already-validated `state.step` (backend already constrains this to a known value).
- **Integration**: renders inside the same page as CHUNK_2's welcome overlay (after dismissal) and CHUNK_4's explainers.

## Dependencies

- **Requires**: None (independent of CHUNK_1/2).
- **Blocks**: None directly, but CHUNK_5's final gate verifies this chunk alongside the others.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_3_STEPPER</promise>
