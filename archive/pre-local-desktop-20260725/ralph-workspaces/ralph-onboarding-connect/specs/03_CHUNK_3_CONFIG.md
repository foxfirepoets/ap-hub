# CHUNK_3_CONFIG: Fix the port collision between the pipeline HTTP server and Next.js

## Summary

`PORT` (the plain HTTP server that owns OAuth callbacks) defaults to `3000` — the same as Next.js's `npm run web:dev` default — so running both together in dev collides. This chunk changes the dev default to `3001` and updates the Gmail/QBO redirect-URI defaults to match, plus updates AGENTS.md/README/docs that mention the old assumption. A small, mechanical, config-only chunk that unblocks CHUNK_4/5 from being runnable together locally.

## Acceptance Criteria

- [ ] `src/config.ts`'s `PORT` default changes from `3000` to `3001`.
- [ ] `GMAIL_REDIRECT_URI` default changes from `http://localhost:3000/oauth/gmail/callback` to `http://localhost:3001/oauth/gmail/callback`.
- [ ] `QBO_SANDBOX_REDIRECT_URI` default changes from `http://localhost:3000/oauth/qbo/callback` to `http://localhost:3001/oauth/qbo/callback`.
- [ ] `WEB_BASE_URL`'s default (`http://localhost:3000`) is UNCHANGED — that's the Next.js app's own port, correct as-is.
- [ ] Any existing test asserting the old `3000` default for `PORT`/`GMAIL_REDIRECT_URI`/`QBO_SANDBOX_REDIRECT_URI` (check `test/config.test.ts`) is updated to assert the new default — this is the one intentional test change in this whole feature, and it must be scoped to exactly these default-value assertions, nothing else in that file.
- [ ] `npm run dev` and `npm run web:dev` can both be started together without a port bind conflict (manually verify, or note as a build-phase check).
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No HTTP endpoints — configuration only.

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: `loadConfig({})` (no env overrides) → `PORT === 3001`, `GMAIL_REDIRECT_URI` and `QBO_SANDBOX_REDIRECT_URI` both point at `:3001`.
- **Edge case**: an explicit `PORT` env var still overrides the default (unchanged zod behavior) — assert this still works, this chunk only changes the DEFAULT, not the override mechanism.
- **Failure case**: N/A — config loading has no new failure mode from a default-value change.
- **Integration**: CHUNK_2's redirect target (`WEB_BASE_URL`) and CHUNK_4's authorize-URL builders (`GMAIL_REDIRECT_URI`/`QBO_SANDBOX_REDIRECT_URI`) both read these same config values — verify by grep, don't just trust the config file changed.

## Dependencies

- **Requires**: None (independent of CHUNK_1/2, can run in parallel conceptually, but sequenced here for orchestrator simplicity).
- **Blocks**: None directly, but CHUNK_4/5's manual verification steps assume this port fix is in place.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_3_CONFIG</promise>
