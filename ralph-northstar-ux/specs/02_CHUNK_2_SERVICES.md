# CHUNK_2_SERVICES: Extract a shared service layer that both the CLI and the API call

## Summary

Extracts the approve / reject / remap / learn / reply operations into `src/services/*` so the CLI, the pipeline, and the new API routes all share one code path — never a second implementation. Each service function centrally writes `audit_log` and routes irreversible effects through the existing guarded functions (`src/qbo/write.ts`, `src/gatekeeper/forwarder.ts`). This chunk enforces the thin-client rule structurally: routes will have nothing to call except these services.

## Acceptance Criteria

- [ ] `src/services/` exposes `approveProposal`, `rejectProposal`, `remapMapping`, `learnCorrection`, `retryProposal`, `sendReply` — each taking an actor + tenant context.
- [ ] Approve routes through the existing propose/post_sandbox path → `src/qbo/write.ts` only; no new QBO-write code exists.
- [ ] `sendReply` invokes `src/gatekeeper/forwarder.ts` with NO recipient parameter.
- [ ] Every service function appends an `audit_log` row with the real human actor.
- [ ] The existing CLI commands call these same functions (no behavior change to the CLI).
- [ ] All tests pass with zero failures (including the six-guarantee suite).

## Endpoints / Interfaces

No HTTP endpoints — internal service layer only. Exposes typed service functions consumed by CHUNK_4_ACTION.

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: `approveProposal` produces one posting (mode=sandbox) + one audit_log row via the existing write path.
- **Edge case**: `sendReply` cannot be given a recipient; forwarder called with the locked address.
- **Failure case**: SwarmSync outage during approve → service returns a held/review result, never fail-open.
- **Integration**: CLI and (future) API routes both invoke the identical service function — single code path.

## Dependencies

- **Requires**: CHUNK_1_AUTH (actor/tenant context types)
- **Blocks**: CHUNK_4_ACTION

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_2_SERVICES</promise>
