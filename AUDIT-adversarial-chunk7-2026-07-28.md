# Adversarial Spec-vs-Build Audit — CHUNK_7_BACKUP
**Date:** 2026-07-28
**Stamp:** FRESH CONTEXT — independent auditor, no prior conversation with the builder, no reliance on the prior audit's conclusions. `AUDIT-brutal-chunk7-2026-07-27.md` was read only as a checklist of things to go re-derive from the actual code myself; every claim in it was re-proven or re-refuted from source and from real test runs in this session.
**Branch:** `feat/local-desktop-p1` (confirmed via `git status` / `git branch --show-current`)
**Environment:** code-only. This is a local-first Electron desktop app with no hosted URL and no staging server. I did not launch a packaged/dev Electron build and click through Settings. All "DONE" verdicts below are code + automated-test verdicts, not live-UI verdicts.

## Verdict

**CANNOT CERTIFY (code-only) — NO-GO for public release without further work.**

This is not rounded up to GO. The backend engineering (encryption, verify-by-re-read, rotation, the destroy-and-restore swap mechanics) is genuinely strong and is proven by real, passing, non-trivial integration tests I executed myself. But three acceptance bullets have real gaps I can point to in the code (pre-migration/pre-update backup triggers are simply never called; repair mode exists but is wired to nothing; a restore-external code path can leave a `backups` row marked "verified" even when its actual re-verification fails), and no UI-level or packaged-Electron proof of the Settings backup flow exists anywhere in the repo (no `e2e-desktop/*backup*.spec.ts`, and `settings.spec.ts` never mentions backup).

## What I actually ran (not described — executed, output below)

```
$ git branch --show-current
feat/local-desktop-p1

$ npx vitest run test/backup-ipc.test.ts test/ipc-contract.test.ts test/ipc-action-domains.test.ts
 ✓ test/ipc-contract.test.ts (603 tests) 51636ms
 ✓ test/ipc-action-domains.test.ts (288 tests) 3234ms
 ✓ test/backup-ipc.test.ts (18 tests) 11690ms
 Test Files  3 passed (3)
      Tests  909 passed (909)

$ npx vitest run --mode integration test/backup-create.int.test.ts test/backup-restore.int.test.ts test/backup-rotation.test.ts test/backup-repair.int.test.ts
 ✓ test/backup-restore.int.test.ts (3 tests) 43302ms   <- real bundled PostgreSQL, real pg_dump/pg_restore
 ✓ test/backup-create.int.test.ts (4 tests) 35265ms
 ✓ test/backup-repair.int.test.ts (4 tests) 13761ms
 Test Files  3 passed (3)
      Tests  11 passed (11)

$ npx vitest run test/backup-rotation.test.ts
 ✓ test/backup-rotation.test.ts (11 tests)   Test Files 1 passed / Tests 11 passed

$ npx vitest run test/lockdown.test.ts test/gatekeeper.test.ts test/posting.test.ts test/anchor-whitelabel.test.ts test/architecture-connector-path.test.ts
 ✓ test/posting.test.ts (21 tests)
 ✓ test/gatekeeper.test.ts (6 tests)
 ✓ test/architecture-connector-path.test.ts (4 tests)
 ✓ test/anchor-whitelabel.test.ts (2 tests)
 ✓ test/lockdown.test.ts (7 tests)
 Test Files  5 passed (5) / Tests 40 passed (40)

$ npx tsc --noEmit
(zero output — clean)

$ node scripts/lint-noleak.mjs
lint:noleak OK — no provider/OS boundary leaks.
```

I did **not** run the full `npm run verify` gate (full unvarying `npm test`, `npm run lint`, `npm run web:build`, `npm run test:ui-contract`/Playwright) — that is a much larger surface than CHUNK_7 and was out of scope for the time budget here. Everything above is real, fresh output from this session, not a description of output I didn't see. None of the five named safety tests were touched or edited.

## Reconciliation table (auditor-assigned R1–R12, in spec's own bullet order)

| ID | Requirement (paraphrased) | Status | Evidence |
|----|---|---|---|
| R1 | Nightly + pre-migration + pre-update backups, without stopping engine | **PARTIAL** | Nightly: DONE — `desktop/main.ts:381-382` calls `startQueue`/`registerPipelineJobs`; `src/pipeline/register.ts:50,65,81,90` wires `JOBS.backup_nightly` to `backupNightlyHandler`; `src/backup/rotation.ts:224-228` schedules `0 2 * * *` UTC via pg-boss; `createBackup` uses `pg_dump -Fc` against the live running instance (no stop). **Pre-migration/pre-update: MISSING.** `BACKUP_KINDS` includes `'pre_migration'`/`'pre_update'` (`src/backup/create.ts:18`) but `grep -rn "createBackup(" src desktop app` shows exactly two production call sites — `src/backup/http.ts:142` (`kind:'manual'`) and `src/backup/rotation.ts:192` (`kind:'scheduled'`) — and zero call sites anywhere with `kind: 'pre_migration'` or `kind: 'pre_update'`. `src/db/migrate.ts` has no backup hook at all. |
| R2 | Key only in OS credential store; never recoverable from disk; never crosses IPC | **DONE** | `src/backup/key.ts` — key generated via `randomBytes(32)`, stored/read only through `SecretStore`; never written to `install.json`, `backups` table, or a log line (module doc + migration comment `migrations/015_backups.sql:13-16` reiterate this). `src/backup/http.ts` responses (`runListBackups`, `runCreateBackup`, `runExportBackup`) never include the key. Proven by passing tests: `runExportBackup > copies the already-encrypted file byte-for-byte ... and never reads the key`. |
| R3 | Verify by re-reading; unverified never counted | **PARTIAL** | Create path DONE: `src/backup/create.ts:124-147` only sets `verified_at` when `verifyBackup()` (decrypt + hash + restore-into-scratch-db + row-count check, `src/backup/verify.ts`) passes; proven live by `backup-create.int.test.ts`'s tamper/truncation tests. **Defect found in restore-external path** — see Defect #1 below: the imported row's `verified_at` is set from the *sidecar's claimed* value, written to the DB, *before* the actual re-verification (inside `restoreBackup`) runs, and is never rolled back if that re-verification then fails. |
| R4 | Rotation 7 daily / 4 weekly / 3 monthly + all pre-update + never prune to zero verified | **DONE (logic)** | `src/backup/rotation.ts:87-120` (`selectBackupsToPrune`) implements the bucketing, the unconditional `pre_update` keep, and the "always keep newest verified" invariant; `pruneBackups` re-checks safety immediately before each delete. 11/11 unit tests pass. Caveat: since R1's pre-update trigger never fires in production, this logic's `pre_update` branch is currently dead in practice, not just in theory — it is exercised only by unit tests, never by a real pre-update backup. |
| R5 | Corrupted backup ⇒ visible warning + native notification | **DONE (for backup creation), gap for restore** | `desktop/main.ts:373-380` wires `setBackupFailureAlerter` to `new Notification({...}).show()`; `src/backup/http.ts` calls `alertBackupFailure(...)` on every `runCreateBackup` failure branch (verify-failed, disk-full, generic) and `src/backup/rotation.ts:185,209,216` calls it on every nightly-failure branch. **Gap:** `runRestoreBackup` and `runRestoreExternalBackup` never call `alertBackupFailure` — a failed restore only shows the in-app notice banner (visible only while Settings is open), no native OS notification. The spec's literal wording ("a corrupted backup is reported as failed... plus a native notification") is about backup creation, so this is not a strict R5 violation, but it is a real, findable gap in the same safety pattern — see Defect #4. |
| R6 | Destroy-and-restore drill from the AP-Hub **UI**, one confirmation, counts/audit/postings match exactly | **PARTIAL / CANNOT CERTIFY the UI half** | Module-level drill genuinely proven: `test/backup-restore.int.test.ts` — "backs up, genuinely destroys the live data, restores, and matches the pre-destruction state exactly" — independently snapshots `messages, attachments, attachment_blobs, proposals, postings_ap, audit_log, exceptions` row-for-row before/after (lines 65-102, 214, 237, 260) and passes against a real bundled PostgreSQL. The UI's single-confirmation gate is implemented (`BackupPanel.tsx:297-346` — checkbox + must type `RESTORE`). **But no e2e-desktop test exercises this through the real Electron app**: `find e2e-desktop -iname "*backup*"` returns nothing, and `e2e-desktop/settings.spec.ts` has zero references to "backup". The destroy-and-restore drill has never been proven to work through the actual IPC bridge + renderer + Electron main process chain — only through directly calling `restoreBackup()` in a Vitest process. |
| R7 | External-folder restore, user-selected, never automatic, never AP-Hub-operated | **DONE (code), with the R3 defect attached** | `aphub:backup:restore-external` channel exists (`desktop/ipc/action/backup.ts:47-57`); path is always a user-typed field in `BackupPanel.tsx:274-280`, never auto-populated or defaulted; `runRestoreExternalBackup` refuses without a `.meta.json` sidecar (tested: "404 when the exported file or sidecar is missing"). See Defect #1 for the verification-bookkeeping gap that lives inside this same code path. |
| R8 | Repair mode: reinstall components + rebuild derived state without altering user data, row-level proof | **STUB / unreachable from the product** | `src/backup/repair.ts` is a real, well-built module: idempotent `migrateUp`, 3 FK-mirroring orphan checks, install-linkage check, backup-key presence check — and `test/backup-repair.int.test.ts` (4/4 passing) proves it touches zero user-data tables. **But it is wired to nothing**: `grep -rln "runRepair\|backup/repair" desktop app src` (excluding the module itself) returns **zero files**. There is no IPC channel, no button, no CLI command that reaches `runRepair()`. Meanwhile `desktop/ipc/errors.ts:120` and `app/lib/onboardingErrors.ts:123` both tell the user in plain language to "use Repair if this keeps happening" — pointing at a feature that does not exist as a reachable action anywhere in the product. Also note by the module's own doc comment (`repair.ts:15-16`): the "reinstalls program components" half of R8 is explicitly out of scope here (deferred to CHUNK_9_PACKAGE), so even fully wired, R8 would only be half-satisfied today. |
| R9 | Exportable single encrypted file + plain-language key-location disclaimer | **DONE** | `runExportBackup` copies the encrypted `.aphubbak` byte-for-byte, never touches the key (`src/backup/http.ts:265-266`); `BackupPanel.tsx:100-103` states "The key to open it still lives only on this computer — keep this computer's secure storage, or you cannot restore later," and the restore-external panel repeats it (`BackupPanel.tsx:291-293`). |
| R10 | `list`/`restore` owner-only, never return key or credential-store handle | **DONE** | All four backup channels (`list`, `create`, `restore`, `restore-external`, `export`) declare `role: ['owner_controller']` in the registry (`desktop/ipc/read/backup.ts`, `desktop/ipc/action/backup.ts`) **and** independently re-check via `readContext(request, 'owner_controller')` inside every `run*` handler in `src/backup/http.ts` — double-enforced, not just declarative. Proven live: `ipc-contract.test.ts`'s exhaustive 603-test role matrix (owner/bookkeeper/cpa × every one of 57 channels) passed, plus `backup-ipc.test.ts`'s explicit 401/403 assertions for every backup channel. |
| R11 | Settings shows most recent verified backup in plain language | **DONE (code); UI render UNVERIFIABLE** | `BackupPanel.tsx:163-167` renders exactly the spec's example style: `"Most recent verified backup: {when} — checked and readable ({size})."`. No e2e-desktop test renders and reads this text from a real window (same gap as R6) — code correctness is clear, live render is not proven. |
| R12 | `npm run verify` exits 0 | **UNVERIFIABLE (full gate not run)** | I ran `tsc --noEmit` (clean), `lint:noleak` (clean), and 971 targeted tests across contract/action-domain/backup-unit/backup-integration/five-safety-suites (all passing, real output above). I did not run the full `npm run verify` (full `npm test` across the whole suite, `npm run lint`, `npm run web:build`, `npm run test:ui-contract`/Playwright) — out of scope for this pass's time budget. This is an honest gap, not a pass. |

## Fake-completion sweep

- No `TODO`/`FIXME`/"not implemented"/hardcoded-return stubs found anywhere under `src/backup/*`, `desktop/ipc/{read,action}/backup.ts`, or `BackupPanel.tsx` (`grep -rn "TODO\|FIXME\|not.implemented\|stub\|hardcoded\|placeholder" -i` — only hits were legitimate HTML `placeholder=` attributes).
- No dead IPC routes: every `aphub:backup:*` channel registered in `desktop/ipc/action/channels.ts` / `desktop/ipc/read/channels.ts` has a matching entry in `app/lib/ipc-routes.ts` and a real `run*` implementation in `src/backup/http.ts` — none of them return a canned/fake success.
- Export and restore genuinely touch the filesystem: `copyFile`, `writeFile` (sidecar), `readFile` (sidecar on restore), `pg_dump`/`pg_restore` via `runPgTool` — verified by reading the code and by the integration tests actually exercising real bundled PostgreSQL binaries.
- **One real fake-completion-adjacent finding**: `runRepair()` (R8) is a fully real implementation with real tests, but it is unreachable from the product — this reads exactly like "feature built, never wired," the pattern this sweep exists to catch. See Defect #2.
- BackupPanel.tsx success copy is honest: `backUpNow()`, `exportBackup()`, and `confirmRestore()` all gate the "good" notice strictly behind `result.ok === true`; every failure path renders `result.error?.message` in a `notice bad` div. I did not find any code path where the UI claims success after the backend returned an error.

## Adversarial results

| Probe | Expected | Observed |
|---|---|---|
| Owner vs bookkeeper/cpa role gating on all 4 backup action channels + 1 read channel | 401 no session / 403 wrong role | **PASS** — `backup-ipc.test.ts` (18/18) + `ipc-contract.test.ts` exhaustive matrix (603/603), read directly from `readContext(request, 'owner_controller')` in `src/backup/http.ts`, not inferred from a comment |
| Missing `.meta.json` sidecar on restore-external | refused, no fabricated row | **PASS** — `runRestoreExternalBackup` requires `format === 'aphub-backup-meta-v1'` plus `manifestHash`/`rowCounts`/`verifiedAt` present, tested ("404 when the exported file or sidecar is missing") |
| Unverified export refusal | export of an unverified backup refused | **PASS** — `runExportBackup` returns `NOT_FOUND` when `row.verified_at === null` (`src/backup/http.ts:262-264`), tested ("refuses to export an unverified backup") |
| Folder export vs full file-path export | both work | **PASS** — `resolveExportFilePath` (`src/backup/http.ts:57-74`) detects an existing directory or a trailing-slash/no-extension path and writes `aphub-backup-{id}.aphubbak` inside it; tested ("when destination is a folder, writes aphub-backup-{id}.aphubbak inside it") |
| Restore failure leaves original data untouched | untouched | **PASS**, and unusually well engineered: `restoreBackup()` uses a restore-into-fresh-database-then-rename-swap strategy (`src/backup/restore.ts:187-403`) so the live DB is never touched until a fully verified replacement exists; a crash mid-swap leaves a recovery marker for the next boot. Proven live: "refuses to restore from a tampered backup, and never touches the live database" and "recovers automatically from a crash between the two rename-swap steps" both passed against real PostgreSQL. |
| Restore-external: does the imported row get marked verified before real re-verification, and is it cleaned up on failure? | should not be marked/counted until genuinely re-verified | **FAIL — see Defect #1** |
| Disk-full mid-backup surfaces `DISK_FULL` | tested | **UNVERIFIABLE** — code path exists (`isDiskFullError`, `ENOSPC` checks in `create.ts`/`http.ts`) but no test in `backup-ipc.test.ts` or `backup-create.int.test.ts` simulates `ENOSPC`; behavior is asserted by code inspection only, not by a passing test |
| Second email/notification "send" path introduced by backup work | none | **PASS** — only one `new Notification(` call site in the whole repo (`desktop/main.ts:376`), which is the local OS notification API, not a provider send; `lockdown.test.ts` (asserts exactly one `sendForward` call site) passed unmodified |
| Secrets (backup key, DB creds) never in Postgres/install.json/logs/env/renderer | true | **PASS** — key lives only via `SecretStore`; DB creds in `create.ts`/`restore.ts` are written to a short-lived, ACL-hardened `.pgpass` file (`restrictToCurrentUser`) rather than passed on a command line or logged; `lint:noleak` ran clean |

## Defect task cards (business-critical first)

1. **HIGH — `restore-external` can leave a `backups` row falsely marked "verified" after a failed re-verification.**
   File: `src/backup/http.ts`, `runRestoreExternalBackup`, lines ~331–356.
   Problem: The function `INSERT`s a new `backups` row with `verified_at = meta.verifiedAt` (the value *claimed* by the sidecar `.meta.json`, not independently re-derived) *before* calling `restoreBackup()`, which is where the actual decrypt/hash-check/row-count re-verification happens. If `restoreBackup()` then throws (hash mismatch, corrupted file, disk full, etc.), the `catch` block (lines 357–374) returns an error response to the caller but never deletes or un-verifies the row it just inserted. The result: `aphub:backup:list` can subsequently show a backup as "Checked and readable" that in fact failed its real re-verification — directly contradicting the spec's "An unverified backup is reported as failed and never counted." It also means rotation (`selectBackupsToPrune`) could treat this phantom row as a legitimate verified backup.
   Suggested fix direction: wrap the insert + restore in a try/finally that deletes the just-inserted row (and its copied file) on any failure from `restoreBackup()`, or defer the insert until after `restoreBackup()` succeeds.
   Not fixed by me (repair pass is out of scope here) — this is a genuine, previously-unflagged, code-verified defect with no covering test.

2. **HIGH — Repair mode (R8) is fully implemented but unreachable from the product; UI error copy references a nonexistent action.**
   Files: `src/backup/repair.ts` (real, tested implementation); `desktop/ipc/errors.ts:120`; `app/lib/onboardingErrors.ts:123` (both tell the user "use Repair").
   Problem: `grep -rln "runRepair\|backup/repair" desktop app src` (excluding `repair.ts` itself) returns nothing — no IPC channel, no button, no menu item calls it. A user told by the app to "use Repair" has no way to do so.
   Suggested fix direction: add an `aphub:backup:repair` owner-only action channel (mirroring the other backup channels' pattern in `desktop/ipc/action/backup.ts`) and a Settings entry point, or, if repair is intentionally deferred, remove/soften the "use Repair" wording until it exists.

3. **HIGH — Pre-migration and pre-update backups are never triggered anywhere (R1 half-missing).**
   Files: `src/backup/create.ts:18` (kinds declared); `src/db/migrate.ts` (no hook); no call site anywhere with `kind: 'pre_migration'` or `kind: 'pre_update'`.
   Problem: The spec's first acceptance bullet explicitly requires pre-migration and pre-update backups, and the `backups.kind` CHECK constraint and rotation's "keep every pre-update snapshot" logic were clearly built anticipating this — but nothing in the migration runner or any update flow ever calls `createBackup({ kind: 'pre_migration' | 'pre_update', ... })`. A schema migration or a future auto-update currently runs with zero safety-net backup, which is exactly the P0 failure mode ("a backup that appears to work and turns out to be unrestorable" / here, simply never exists) the chunk's own summary calls out.
   Suggested fix direction: call `createBackup({ kind: 'pre_migration' })` at the start of `src/db/migrate.ts`'s `migrateUp` (or its caller) when pending migrations exist, and add the equivalent hook wherever CHUNK_9_PACKAGE's update flow will land (may currently not exist yet — flag as a cross-chunk dependency if so).

4. **MEDIUM — No native notification on restore failure (only on backup-creation/nightly failure).**
   File: `src/backup/http.ts`, `runRestoreBackup` and `runRestoreExternalBackup` — no `alertBackupFailure(...)` calls anywhere in either function, unlike `runCreateBackup` and `backupNightlyHandler` which call it on every failure branch.
   Problem: A failed restore is only visible if the user is currently looking at the Settings panel; there is no OS-level notification the way there is for a failed backup. Given restore is the highest-stakes user-initiated action in this chunk, this is an inconsistency in an otherwise-careful safety pattern.
   Suggested fix direction: call `alertBackupFailure(...)` in the catch branches of both restore handlers, mirroring the create-path pattern.

5. **MEDIUM — `DISK_FULL` behavior is implemented but has zero test coverage.**
   Files: `src/backup/http.ts` (`isDiskFullError`), `src/backup/create.ts`.
   Problem: The spec names disk-full mid-backup as an explicit edge case ("the disk fills mid-backup and surfaces `DISK_FULL` with the pause message"). The code path exists and looks correct by inspection, but no test in `backup-ipc.test.ts` or `backup-create.int.test.ts` (nor anywhere else I found) simulates an `ENOSPC` error to prove the branch is actually reachable and correctly wired end-to-end.
   Suggested fix direction: add a unit test that mocks `pg_dump`/`copyFile`/`writeFile` to reject with `{ code: 'ENOSPC' }` and asserts the `DISK_FULL` response and the "your disk is full" alert both fire.

6. **MEDIUM — No e2e-desktop proof of the backup Settings flow at all (R6 "from the UI", R11 render).**
   Files: `e2e-desktop/*` (no `backup*.spec.ts` exists); `e2e-desktop/settings.spec.ts` (zero mentions of "backup").
   Problem: The single most safety-critical acceptance bullet in the whole chunk ("Destroy-and-restore drill... restore from the AP-Hub UI in one confirmation") has never been exercised through a real Electron window, IPC bridge, and renderer — only through calling `restoreBackup()` directly inside a Vitest process. The one-confirmation-with-typed-`RESTORE`-word gate in `BackupPanel.tsx` has never been clicked by an automated test.
   Suggested fix direction: add `e2e-desktop/backup.spec.ts` that boots the app, calls `aphub:backup:create` (or triggers "Back up now"), asserts the panel shows "Checked and readable," drives the restore-confirmation UI end to end, and asserts the resulting notice text. This is the natural next step to move R6/R11 from PARTIAL to DONE.

7. **LOW — Row-count manifest verification (the automatic check run at every create/restore) does not cover `audit_log` or `exceptions`, even though the spec's own test-scenario language names "audit rows" as something the drill must match.**
   File: `src/backup/manifest.ts:20-26` (`BACKUP_TABLES = ['messages','attachments','attachment_blobs','proposals','postings']`).
   Problem: This is not a data-loss risk — `pg_dump`/`pg_restore` operate on the whole database, so `audit_log` rows are genuinely backed up and restored regardless of `BACKUP_TABLES`. And the one existing destroy-and-restore integration test does independently snapshot `audit_log` and `postings_ap` row-for-row and passes. But the *ongoing, automatic* per-backup verification (`verifyBackup` at create time, and `restoreBackup`'s own post-restore check) — the mechanism that decides whether a backup counts as "verified" in Settings and rotation — would not by itself catch a corruption isolated to `audit_log` (e.g., a table specifically excluded from a future schema change) because it never counts those rows.
   Suggested fix direction: add `audit_log` (and consider `exceptions`) to `BACKUP_TABLES` so the routine verification check, not just the one-off integration test, covers them.

8. **LOW — `Full verify gate-commit.Prompt-7.28.md` and other untracked builder-notes files in repo root** (`AUDIT-brutal-chunk7-2026-07-27.md`, `HANDOFF-2026-07-27*.md`) are not a code defect but are working notes left in the repo root rather than an ignored/scratch location — flagging only because a future contributor could mistake them for authoritative docs. Not fixed (out of scope: "do not fix").

## Residual risk register

| Risk | Notes | Owner | Signed off? |
|---|---|---|---|
| No packaged/dev Electron probe of the Settings backup UI | Neither this audit nor (per its own admission) the prior one ever clicked through the real window. R6's UI half and R11 remain code-only. | Ben | No |
| Restore-external phantom-verified row (Defect #1) | Could let a corrupted external restore be silently offered again from Settings as "Checked and readable" after a failed attempt. | Eng | No |
| Repair mode unreachable (Defect #2) | User-facing error copy promises a feature with no code path to it. | Eng | No |
| Pre-migration/pre-update backups never fire (Defect #3) | The exact scenario CHUNK_7 exists to protect against (a migration or update destroying data) currently has zero automatic safety-net backup. | Eng | No |
| Full `npm run verify` gate not run this pass | Only targeted suites + typecheck + lint:noleak were run (971 tests, all passing, real output above). Full lint/web-build/Playwright status unknown from this session. | Eng/Ben | No |
| Contamination of the prior (2026-07-27) audit | That audit was self-graded by the builder ("CONTAMINATED CONTEXT" by its own header). This audit re-derived every finding from source and from fresh test runs rather than trusting it — but the prior audit's own open items (R8 "MISSING", R1 "nightly only") are echoed here with new, independent evidence, not merely copied forward. | — | Resolved by this audit |

---
**Honesty check:** every DONE/PARTIAL/MISSING verdict above cites a specific file:line or a command I ran with pasted real output in this session. Where I could not get evidence (full verify gate, live Electron UI), I said so as UNVERIFIABLE / CANNOT CERTIFY rather than rounding up.
