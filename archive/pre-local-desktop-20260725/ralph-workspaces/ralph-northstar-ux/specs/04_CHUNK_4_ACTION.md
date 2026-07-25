# CHUNK_4_ACTION: Expose role-gated approve/reject/remap/learn/retry/reply routes over the service layer

## Summary

Wires the action API to the CHUNK_2 service functions, each route gated by role, each producing an `audit_log` entry, each calling only the existing guarded paths. This is the chunk that touches the QBO-write boundary via the service layer — the highest-risk chunk — so it leans hardest on the guarantee tests. It never re-implements pipeline logic and never adds a recipient field to sends.

## Acceptance Criteria

- [ ] `POST /api/proposals/:id/approve` (role `owner_controller` only) produces exactly one `postings` row (mode=sandbox) + one `audit_log` row (human actor) and returns the QBO link.
- [ ] Bookkeeper calling approve → `403 FORBIDDEN`, zero postings.
- [ ] Concurrent double-approve yields exactly one posting (existing idempotency).
- [ ] `POST /api/replies/:id/send` accepts NO recipient field; supplying one → `400 VALIDATION`; it invokes the existing forwarder.
- [ ] `POST /api/mappings/remap` and `/api/corrections/learn` with `remember:true` create a `corrections` row (`became_rule=true`) + `mappings` upsert applied to the next matching item.
- [ ] `POST /api/proposals/:id/retry` re-runs a failed posting safely.
- [ ] Existing six-guarantee suite stays green; all tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/proposals/:id/approve | Owner/Controller: approve → post_sandbox via write.ts |
| POST | /api/proposals/:id/reject | Owner/Controller or Bookkeeper: reject / mark duplicate |
| POST | /api/mappings/remap | Owner/Controller or Bookkeeper: remap (+ remember) |
| POST | /api/corrections/learn | Owner/Controller or Bookkeeper: learn-forever rule |
| POST | /api/proposals/:id/retry | Owner/Controller: safe retry |
| POST | /api/replies/:id/send | Owner/Controller: send draft via locked forwarder (no recipient) |

## Database Changes

No schema changes in this chunk (writes to existing `postings`, `corrections`, `mappings`, `audit_log`, `forwards`).

## Test Scenarios

- **Happy path**: Owner approve → one sandbox posting + audit row + QBO link.
- **Edge case**: double-approve concurrency → one posting (409 ALREADY_POSTED on the loser).
- **Failure case**: reply-send with recipient field → 400 VALIDATION; QBO API failure → item to Exception + safe retry (202 QBO_RETRY).
- **Integration**: approve consumes CHUNK_2 `approveProposal`; results render in CHUNK_5 UI.

## Dependencies

- **Requires**: CHUNK_1_AUTH, CHUNK_2_SERVICES
- **Blocks**: CHUNK_5_FRONTEND (action buttons), CHUNK_6_ONBOARDING (enable auto-post)

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_4_ACTION</promise>
