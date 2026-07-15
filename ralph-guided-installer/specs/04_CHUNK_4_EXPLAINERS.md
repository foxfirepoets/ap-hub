# CHUNK_4_EXPLAINERS: Per-step prerequisite explainers and graphical blocker cards

## Summary

Adds a one-sentence "why this step matters" explainer above each of the 9 existing step bodies (copy-only addition), and restyles the existing "Setup blockers" list into one visually distinct card per blocker (icon + group + message + fix), reading the exact same `state.blockers` data the page already groups today. No new blocker types, no new data.

## Acceptance Criteria

- [ ] Every one of the 9 steps renders a one-sentence explainer text before/above its existing content.
- [ ] Every entry in `state.blockers` renders as exactly one card containing its group, message, and fix text.
- [ ] Blockers remain grouped exactly as today (same `group` field, no merging across groups, no splitting within a group).
- [ ] If `state.blockers` is empty, the blockers panel does not render at all (unchanged from current behavior).
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No HTTP endpoints — internal presentational component only.

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: two blockers in the same group render as two cards under one group heading.
- **Edge case**: an unrecognized blocker `code` (one with no dedicated icon mapping) still renders its raw `message`/`fix` fields — never dropped.
- **Failure case**: N/A — pure rendering from already-fetched `state.blockers`.
- **Integration**: renders inside the same page as CHUNK_2/CHUNK_3; consumed alongside them in CHUNK_5's final gate.

## Dependencies

- **Requires**: None (independent of CHUNK_1/2/3).
- **Blocks**: None directly, but CHUNK_5's final gate verifies this chunk alongside the others.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_4_EXPLAINERS</promise>
