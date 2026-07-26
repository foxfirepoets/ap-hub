# CHUNK_8_SUPERVISION: Keep AP-Hub running across crashes, sleep and reboots on both platforms.

## Summary

Adds autostart, child-process recovery, a bounded crash loop, sleep/wake and network-loss handling,
log rotation and native notifications. It comes late because it supervises components the earlier
chunks built. It hands the packaging chunk a product that survives an ordinary week on a real
computer.

The crash ceiling matters as much as the restart: an unbounded restart loop is a defect, not
resilience.

## Acceptance Criteria

- [ ] Autostart is implemented on **Windows** — per-user Task Scheduler, non-elevated. (macOS LaunchAgent out of Version 1 scope.)
- [ ] Startup sequences PostgreSQL readiness → engine → window.
- [ ] Killing the engine, the PostgreSQL child, or both restores them within **90 seconds** with jobs intact and no duplicate work.
- [ ] Five induced failures within ten minutes **stop** the restart loop and show *"AP-Hub is having trouble starting. Your information is safe."* with Retry and Get support export actions.
- [ ] Rebooting the computer brings AP-Hub back automatically under the same OS account, with work intact.
- [ ] Sleep, wake and network loss resume durable cursors and jobs with **no duplicate work**; clock skew does not invalidate durable jobs.
- [ ] A watchdog restart during an uncertain write performs an authoritative provider query before any retry — never a blind replay.
- [ ] Logs rotate at 10 MiB / 10 files with the existing `src/logger.ts` redaction retained and extended to the new surfaces.
- [ ] Native OS notifications fire for crash-loop, disk-full, backup-failed and reconnect-needed states.
- [ ] The tray icon reflects engine, database and connection health **in words, not codes**.
- [ ] All tests pass with zero failures (`npm run verify` exits 0).

## Endpoints / Interfaces

No HTTP endpoints. Supervisor state exposed to the renderer as events, not channels:

| Event | Payload | Surface |
|---|---|---|
| `aphub:status:engine` | `'starting' \| 'running' \| 'restarting' \| 'unstable'` | Tray + Settings status panel |
| `aphub:status:database` | `'starting' \| 'ready' \| 'failed'` | Tray + Settings status panel |
| `aphub:status:backup` | `'ok' \| 'warning'` with a plain-language last-verified string | Settings + notification |

Host adapter additions: `registerAutostart()` / `unregisterAutostart()` behind `src/host/types.ts`,
implemented for Windows Task Scheduler. The macOS branch keeps compiling, unvalidated.

## Database Changes

No schema changes in this chunk. Durable job state uses the existing pg-boss tables.

## Test Scenarios

- **Happy path**: reboot the machine → AP-Hub returns on its own under the same OS account → in-flight jobs resume → no duplicate posting or forward.
- **Edge case**: the machine sleeps mid-job and wakes hours later; durable jobs resume with no user-visible message and no duplicate work. Network loss degrades gracefully and recovers.
- **Failure case**: five induced crashes in ten minutes stop the loop with a typed `ENGINE_UNSTABLE` state and a plain-language message — never an unbounded loop and never a raw error. An antivirus quarantine of a child binary surfaces as `ENGINE_UNSTABLE` with a repair action.
- **Integration**: `test/host-contract.test.ts` proves child kill restores and the crash ceiling stops with a typed state; the notifications are the ones CHUNK_7's backup failures raise.

## Dependencies

- **Requires**: CHUNK_1_SHELL (the supervisor lives in main), CHUNK_2_DATABASE (the PostgreSQL child), CHUNK_7_BACKUP (backup-failed notification).
- **Blocks**: CHUNK_9_PACKAGE.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_8_SUPERVISION</promise>
