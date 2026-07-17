# CHUNK_7_HARNESS: Cross-platform host adapter + non-elevated Windows install & watchdog

## Summary

Build the OS-neutral `HostAdapter` seam and its Windows reference implementation, then the non-admin pilot harness that installs portable Node + Postgres, supervises the three processes (Postgres, backend :3001, Next :3000), and survives silent death via a non-elevated Task Scheduler watchdog. The macOS adapter is implemented and type-checked here but exercised in Phase 1B. See `ARCHITECTURE-ap-hub-platform.md` §2–3.

## Acceptance Criteria

- [ ] `src/host/` — `HostAdapter` + `SecretStore` interfaces + contract-test suite. **Windows adapter** (DPAPI secret store, Task Scheduler autostart, `%LOCALAPPDATA%\APHub`, port probe). **macOS adapter** (Keychain, LaunchAgent, `~/Library/...`) implemented + **type-checks**, not exercised. `HostAdapter` contract suite green on Windows.
- [ ] `install-pilot.ps1`: non-admin install to `%LOCALAPPDATA%\APHub` — consent screen (type `I AGREE`, lists collected telemetry), portable Node + Postgres 16, `initdb`, migrations, `.env` gen (broker URL + token, **no API keys**), port probes (fail loudly with occupying PID), ≥2 GB disk check, `pg_isready` check with Defender-exclusion message on failure, watchdog registration.
- [ ] `start-aphub.ps1` supervisor: starts + monitors the three processes; restarts a dead child; exclusive `supervisor.lock`; emits an `alive` heartbeat every 60s and `watchdog_restart` on a restart.
- [ ] `aphub-watchdog.xml`: Task Scheduler task, **non-elevated**, on-logon + every-5-min, `MultipleInstancesPolicy=IgnoreNew`.
- [ ] `uninstall-pilot.ps1`: unregister task, stop processes; **preserves data by default**; deleting all local data requires a **separate explicit typed confirmation**.
- [ ] `npm run typecheck` green with the macOS adapter present.
- [ ] Manual on a non-dev Windows machine: non-admin install, **no UAC**; kill-backend → restart ≤90 s + telemetry; kill-supervisor → Task Scheduler recovery ≤5 min; reboot → three alive ≤3 min; sleep/wake → `pg_isready` 0; `grep sk-ant|ssk_live %LOCALAPPDATA%\APHub` → **zero**.
- [ ] Existing suite ≥ 212, zero existing tests modified. No elevation requested anywhere.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No HTTP endpoints — `HostAdapter`/`SecretStore` interfaces + PowerShell harness scripts + Task Scheduler XML.

## Database Changes

No schema changes (harness runs the existing + broker migrations at install time; no new migration).

## Test Scenarios

- **Happy path**: install completes non-admin; three processes come up; heartbeats flow.
- **Edge case**: port 3000/3001/55432 occupied → fail with PID+name, not a silent reassignment; sleep/wake → Postgres healthy.
- **Failure case**: force-quit supervisor → Task Scheduler relaunch ≤5 min (`watchdog_restart` reason=cold_start); `initdb` blocked by AV → Defender-exclusion message, non-zero exit.
- **Integration**: emits the CHUNK_6 heartbeats; CHUNK_8 installs this on a real machine and confirms the three numbers.

## Dependencies

- **Requires**: CHUNK_6_TELEMETRY
- **Blocks**: CHUNK_8_DEPLOY

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_7_HARNESS</promise>
