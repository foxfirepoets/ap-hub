# CHUNK_9_PACKAGE: Ship signed installers and certify them on clean machines.

## Summary

Produces the signed Windows NSIS installer and the signed, notarized macOS DMG, implements uninstall
and repair, and executes the clean-machine test plan. It is last because it certifies everything the
previous eight chunks built. It hands the phase its Definition of Done: 24 acceptance criteria
observed on a clean Windows machine and a clean macOS machine, with an artifact each.

Nothing here is marked done on local-only evidence. "Works on my machine" is not done.

## Acceptance Criteria

- [ ] `npm run dist:win` produces an NSIS `.exe` installing to `%LOCALAPPDATA%\APHub` with **no administrator prompt**. No Authenticode certificate is available, so Version 1 ships an **unsigned internal release candidate** plus signing-ready configuration, an artifact SHA-256, a build manifest, and the exact future signing command.
- [ ] ~~macOS `.dmg`~~ — **OUT OF VERSION 1 SCOPE** (`docs/decisions/windows-only-v1-2026-07-25.md`).
- [ ] Signing identities are referenced by name from the build machine's secret store and **never committed**.
- [ ] Installer size ≤ 200 MB; install duration on a clean machine ≤ 5 minutes; cold launch to a usable window ≤ 15 seconds; warm launch ≤ 4 seconds.
- [ ] Uninstall removes program components and **asks explicitly** what to do with user data — never deletes silently, never leaves data with no way to remove it.
- [ ] Repair reinstalls components without altering any document, proposal, posting or audit row.
- [ ] Clean-machine run on the strongest available clean Windows environment (Windows Sandbox > new standard non-admin account > disposable VM > isolated install dir + profile) with **no Node, PostgreSQL, Docker or Git**.
- [ ] Listener inspection captured: `Get-NetTCPConnection` shows no AP-Hub listener except the bundled PostgreSQL, the transient OAuth callback and the QuickBooks Web Connector endpoint — and no non-loopback binding.
- [ ] Cross-account isolation, child-kill, crash-ceiling and reboot drills captured on Windows.
- [ ] Destroy-and-restore drill captured on Windows with matching counts, audit rows and postings.
- [ ] Restore from a user-nominated external folder exercised; corrupted-backup handling shows a visible warning and prunes nothing.
- [ ] A repository scan confirms **exactly one** provider-send call site — `sendForward` in `src/gmail/adapter.ts` — still recipient-bound with no recipient parameter. Zero occurrences is a **failure**, not a pass.
- [ ] SmartScreen friction recorded (an unsigned build will warn; expected and labelled).
- [ ] `README.md`, `INSTALL.md`, `AGENTS.md` and all UI copy reconciled with observed behavior, stating every remaining limitation.
- [ ] All tests pass with zero failures (`npm run verify` exits 0) **with no existing test modified**.

## Endpoints / Interfaces

No new runtime interfaces. Build and packaging surface only:

| Command | Produces |
|---|---|
| `npm run dist:win` | NSIS `.exe`, non-admin, per-user install (unsigned in V1) |
| ~~`npm run dist:mac`~~ | *Out of Version 1 scope* |

Update delivery in this phase is **manual only** — the user downloads the next signed installer and
runs it. Automatic checking is P4 and must not be foreclosed: the pre-update snapshot and the
`local_install.app_version` field exist so P4 has what it needs.

## Database Changes

No schema changes in this chunk. A pre-update backup snapshot is taken before any version change.

## Test Scenarios

- **Happy path**: a standard non-admin user on a clean machine double-clicks one file, gets an icon, clicks it, and reaches a working AP-Hub window in under ten minutes with no technical question asked.
- **Edge case**: a system PostgreSQL is already running on 5432 — AP-Hub installs and runs without disturbing it, verified by inspecting the system instance afterwards. SmartScreen/Gatekeeper warn until certificate reputation builds; the friction is recorded, not hidden.
- **Failure case**: uninstall without an explicit data choice is a defect; repair that changes one audit row is a defect; a tampered installer signature is refused with the previous version left intact.
- **Integration**: this chunk is the integration test for the whole phase — every prior chunk's exit criterion is re-observed in an installed environment rather than a development one.

## Dependencies

- **Requires**: all of CHUNK_1 through CHUNK_8.
- **Blocks**: nothing in P1. Unblocks P2 (discovery), which needs a desktop app to live in.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_9_PACKAGE</promise>
