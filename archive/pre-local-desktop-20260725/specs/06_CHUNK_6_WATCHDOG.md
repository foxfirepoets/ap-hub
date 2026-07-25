# CHUNK_6_WATCHDOG: Operate AP Hub continuously under the owning Windows profile

## Summary

This chunk makes the guided standard-user installer and Task Scheduler watchdog the canonical
runtime. It supervises database readiness, backend/workers, and UI with bounded crash recovery,
local status, rotation, wake/network recovery, and actionable Windows notifications.

## Acceptance Criteria

- [ ] Install uses `%LOCALAPPDATA%\APHub`, current-user ACLs, recorded SID, and no public hosting.
- [ ] Per-user Task Scheduler starts AP Hub after sign-in and restores killed children within 90 seconds.
- [ ] Crash loops back off and stop after five failures in ten minutes with a visible error.
- [ ] Status reports process, DB, queue, Gmail, QuickBooks, disk, poll, and backup health without secrets.
- [ ] Sleep/network loss resumes durable polling/jobs without duplicate work.
- [ ] Logs rotate locally and critical failures produce Windows-local notifications.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|---|---|---|
| GET | `/api/runtime/status` | Authenticated local runtime/provider status |

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: clean standard-user install reaches healthy UI/workers after sign-in.
- **Edge case**: wake from sleep and restored network resume from durable cursors.
- **Failure case**: repeated child crashes trigger bounded backoff and visible recovery guidance.
- **Integration**: watchdog starts the exact loopback and secret-store paths from earlier chunks.

## Dependencies

- **Requires**: CHUNK_1_SECRETS, CHUNK_2_AUTH
- **Blocks**: CHUNK_7_CERTIFICATION

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_6_WATCHDOG</promise>
