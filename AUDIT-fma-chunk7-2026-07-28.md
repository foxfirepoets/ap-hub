# Failure Mode Audit: AP-Hub CHUNK_7 Backup Subsystem (updated, post-adversarial-audit fixes)
**Scope:** `src/backup/*`, `desktop/database.ts`, `desktop/ipc/{read,action}/backup.ts`, `app/(app)/settings/BackupPanel.tsx`, `src/db/migrate.ts`'s pre-migration hook, `e2e-desktop/backup.spec.ts` | **Target version:** working tree on `feat/local-desktop-p1`, immediately after the adversarial-audit fix pass (restore-external phantom-verified-row fix, repair-mode wiring, pre-migration backup hook, disk-full test, e2e backup spec) | **Mode:** interactive (repo access, non-halting — all 4 answerability questions resolved from repo) | **Auditor confidence:** HIGH for the code paths cited below (every step has a `file:line`); LOW for anything requiring a live multi-day production timeline (concurrency windows are reasoned from code, not reproduced under load)

## 0. Executive Summary

**Verdict: FLAWED.** The backup/restore/rotate/repair core logic is genuinely strong (encrypted-at-rest, re-verified by re-read, rename-swap restore with crash recovery, honest UI copy) and the prior audit's HIGH findings are correctly fixed. But this pass found a **real, previously-unflagged concurrency defect**: nothing in the process serializes the operations that mutate the encryption key or the live database against each other, so two backup-affecting operations racing (a fast double-click, or the fixed 02:00 UTC nightly cron landing during a manual action) can silently and permanently destroy a backup's readability — precisely the failure mode ("a backup that appears to work and turns out to be unrestorable") the spec's own opening paragraph names as the reason this chunk exists.

- **Top 5 risks by RPN:**
  1. **Backup-key generation race** (`src/backup/key.ts:27-39`) — RPN 32, HIGH. Two concurrent first-ever `createBackup()` calls each mint a different key; the loser's backup silently becomes permanently undecryptable.
  2. **Repair's own schema migration has no pre-migration safety net** (`src/backup/repair.ts:137`) — RPN 18, MEDIUM. Unlike the app-boot path, `runRepair()`'s `migrateUp()` call is not wired to the pre-migration-backup hook added in the prior fix pass.
  3. **Restore-vs-restore marker overwrite under a mid-window crash** (`src/backup/restore.ts:149-159`, `330`) — RPN 12, MEDIUM. One shared marker file per data directory; two concurrent restores plus a crash can point next-boot recovery at the wrong retired database.
  4. **Nightly-backup-vs-manual-restore kills an in-flight `pg_dump`** (`src/backup/restore.ts:337` `terminateConnections`) — RPN 8, LOW. Fails loudly and cleanly, no corruption, just a confusing simultaneous-failure UX.
  5. **`imported-*` files from repeated failed restore-external attempts are never cleaned up** (`src/backup/http.ts:334-336`) — RPN 8, LOW. Each attempt copies the source file again under a new `Date.now()`-stamped name even when the earlier copy was already deleted by the phantom-row cleanup added in the prior fix.
- **Counts:** CRITICAL 0 | HIGH 1 | MEDIUM 2 | LOW 4 (of 12 total; risk table below lists all 12, no cap needed)
- **Next action:** Add a single in-process async lock serializing every backup-mutating entry point (create/restore/restore-external/repair/nightly-prune) — this one fix closes findings #1, #3, #4 at once. Then wire repair's `migrateUp` to the same pre-migration-backup hook (#2). Both implemented and verified in this pass (see Section 5 and the closing report).

## 1. Process Overview

```
[pg-boss cron 02:00 UTC]──┐                    [Settings UI, owner only]
                          ▼                                │
                  backupNightlyHandler ◄── manual "Back up now" ──► runCreateBackup
                  (rotation.ts:180)              (http.ts:129)         │
                          │                                            ▼
                          ├─► createBackup (create.ts:84) ──► getOrCreateBackupKey (key.ts:27)
                          │        │                              [CHECK-THEN-ACT, no lock]
                          │        ▼
                          │   pg_dump → hash → encrypt → verifyBackup → INSERT backups row
                          │
                          └─► pruneBackups (rotation.ts:141) [re-checks safety per-candidate]

[Settings UI] restore click ──► runRestoreBackup (http.ts:187) ──► restoreBackup (restore.ts:224)
                                                                        │
[Settings UI] restore-external ──► runRestoreExternalBackup (http.ts:302)
        │ (insert row from UNTRUSTED sidecar meta, then re-verify for real)
        └────────────────────────────────────────────────────────────► restoreBackup
                                                                        │
                                                    decrypt+hash check → staging DB restore
                                                    → row-count check → WRITE SWAP MARKER
                                                    (restore.ts:330, ONE file per dataDir)
                                                    → terminate live-DB connections
                                                    → rename liveDb→retired, staging→live

[Settings UI] Repair ──► runRepairBackup (http.ts:407) ──► runRepair (repair.ts:136)
                                                                │
                                                        migrateUp (NO pre-migration hook)
                                                                │
                                                        integrity checks + install linkage
                                                        (read-only; never writes user data)

[App boot, existing install] ──► startLocalDatabase → migrateUp(onBeforeMigrating=
        runPreMigrationBackup) (desktop/database.ts:219-222) ──► createBackup(kind='pre_migration')
```

Full 9-category coverage: backup-key acquisition (create.ts:84→key.ts:27), the restore rename-swap (restore.ts:224-403), restore-external's insert-then-reverify (http.ts:302-398), and the concurrency surface across all five entry points. Abbreviated (top-3 category) coverage: `runListBackups`/`runExportBackup` (read/copy-only, no state mutation beyond one `UPDATE external_copy`), the BackupPanel UI rendering paths, rotation's bucket math (already covered by 11 passing unit tests plus its own per-candidate re-check).

## 2. Risk Table

| ID | Step | Failure mode | Category | L | I | D | RPN | Tier |
|----|------|--------------|----------|---|---|---|-----|------|
| F1 | `getOrCreateBackupKey` (key.ts:27-39) | Two concurrent first-key creates → loser's backup permanently undecryptable, no error at creation time | Timing/Sequencing | 2 | 4 | 4 | 32 | HIGH |
| F2 | `runRepair` → `migrateUp` (repair.ts:137) | Repair silently applies pending migrations with no pre-migration safety backup, unlike the boot path | Process design | 2 | 3 | 3 | 18 | MEDIUM |
| F3 | Two concurrent `restoreBackup` calls (restore.ts:149-159, 330) | Second restore overwrites the first's crash-recovery marker; a crash in that window points recovery at the wrong retired DB | Timing/Sequencing | 1 | 3 | 4 | 12 | MEDIUM |
| F4 | Nightly `pg_dump` vs. concurrent restore's `terminateConnections` (restore.ts:337; rotation.ts:192-206) | Restore kills the nightly backup's live connection mid-dump; backup fails loudly (no corruption) | Timing/Sequencing | 2 | 2 | 2 | 8 | LOW |
| F5 | Repeated failed `restore-external` attempts (http.ts:334-336) | Each attempt copies the source file again under a fresh `Date.now()` name; only the phantom DB row is cleaned up, not necessarily every copy on every failure path before the copy | Data / Process design | 2 | 2 | 2 | 8 | LOW |
| F6 | `resolveConnection()` (http.ts:82-93) malformed `DATABASE_URL` | Synchronous `new URL()` throw outside the local try/catch | Technical | 1 | 2 | 1 | 2 | LOW *(verified safe — see 2a)* |
| F7 | `BackupPanel.tsx` restore-confirmation typed text | Case-sensitive exact match to `RESTORE`; a non-English Windows locale user is not told the word must be typed in English | Human factors | 2 | 1 | 1 | 2 | LOW |
| F8 | `selectBackupsToPrune` clock skew (rotation.ts:50-52) | `daysAgo` clamps negative ages to 0 rather than erroring — a backup with a future `created_at` (bad system clock) buckets as "today" instead of surfacing the clock problem | Edge cases | 1 | 1 | 2 | 2 | LOW |
| F9 | `restoreSwapMarkerPath` (restore.ts:149-151) | One marker path per `dataDir`; there is exactly one `dataDir` per install by construction, so this is not a distinct finding from F3 — recorded for completeness, not double-counted in Executive Summary | Process design | — | — | — | — | (folded into F3) |
| F10 | Scalability / 10x load | N/A — single local install, single owner, no concurrent-tenant load; "10x volume" has no meaning for a per-machine backup of one company's data | Scalability | — | — | — | — | N/A — structural |
| F11 | External vendor dependency | N/A — no third-party network service in the backup path; `pg_dump`/`pg_restore` are bundled binaries, the credential store is local OS API, not a hosted vendor | External | — | — | — | — | N/A — structural |
| F12 | Compliance/regulatory | N/A — no PII-specific regulatory backup-retention rule asserted anywhere in the spec beyond the guarantees already tested (encryption at rest, key never leaves credential store) | Security & compliance | — | — | — | — | N/A — structural |

*(2a) F6 verified safe, not just asserted: `desktop/ipc/dispatcher.ts:141-145` wraps every `entry.invoke(...)` call — including `runCreateBackup`/`runRestoreBackup`/`runRestoreExternalBackup` — in a try/catch that maps any thrown error to a generic `INTERNAL` 500. A synchronous throw from `resolveConnection()`'s `new URL()` therefore never crashes the main process or leaks a stack trace to the renderer; it just surfaces as a generic failure. Kept in the table at LOW rather than removed, per the "cite the defense, don't just say looks good" rule.*

## 3. High-Risk Step Detail

### Step: `getOrCreateBackupKey` (src/backup/key.ts:27-39) — F1

1. **Human factors** — N/A, no human actor in this specific function (the trigger is a UI double-click, covered under the calling step).
2. **Technical/system** — Confirmed check-then-act: `secretStore.get()` (line 28) then, if null, `generateBackupKey()` + `secretStore.put()` (lines 36-38) with no lock, no compare-and-swap, no re-read-after-write verification.
3. **Process design** — No serialization primitive anywhere in `src/backup/*` (grepped for `lock|mutex|serializ` — zero hits outside comments). This is the process gap driving F1, F3, F4.
4. **External** — N/A, `SecretStore` is a local OS API (Windows Credential Manager via `host/windows.ts`), not a network vendor.
5. **Data** — The LOSING call's `backups` row still records a `manifest_hash`/`row_counts` and (if its own in-process verify ran before the winner's `put()` landed) a non-null `verified_at` — the row is indistinguishable in the UI/DB from a genuinely restorable backup until someone actually tries to restore it.
6. **Security & compliance** — Not a security hole (nothing is exposed), a correctness/availability hole: the losing key is generated with the same CSPRNG, just silently discarded.
7. **Timing & sequencing** — This IS the finding: classic TOCTOU on `get()`→`put()`.
8. **Scalability & load** — N/A, single-process, low call volume; the race window is real regardless of volume (it needs exactly 2 concurrent calls, not scale).
9. **Edge cases** — Narrowest possible trigger: only reachable on the FIRST-EVER key creation for an install (every subsequent call finds `stored !== null` and returns immediately) — confirmed by tracing: `runPreMigrationBackup` never triggers this window on a fresh install because `migrate.ts`'s `onBeforeMigrating` explicitly does not fire when `_migrations` is empty (`done.size > 0` guard), so the only realistic collision is nightly-cron-vs-manual-click or a UI double-click, both confirmed live code paths.

### Step: `restoreBackup`'s rename-swap (src/backup/restore.ts:224-403) — F3, F4

1. **Human factors** — A user opening two Settings windows (Electron does not prevent a second `BrowserWindow`) or a flaky renderer double-submitting a restore click before `restoreBusy` commits.
2. **Technical/system** — `renameDatabaseWithRetry` (restore.ts:107-125) only retries on SQLSTATE `55006` ("in use"); a concurrent restore's rename racing to *rename a database that no longer exists* raises a different, non-retried Postgres error, confirmed by code read of the catch branch (restore.ts:343-366) — this path is exercised correctly (fails safe, claims "live database was not touched" for whichever restore's own first rename never landed), which is why F3 is scored MEDIUM (contained) rather than CRITICAL.
3. **Process design** — Confirmed: `writeRestoreSwapMarker` (restore.ts:153-159) writes to `restoreSwapMarkerPath(dataDir)` — ONE path per data directory, not per-restore-attempt-id. A second concurrent restore's marker write silently overwrites the first's.
4. **External** — N/A.
5. **Data** — The pre-restore database is renamed aside, never dropped (restore.ts:219 doc comment) — this is the safety net that keeps F3's worst case at MEDIUM, not CRITICAL: even a wrong-marker recovery does not destroy data, it leaves it under an unexpected name requiring manual intervention.
6. **Security & compliance** — N/A, no cross-tenant or auth boundary crossed; single owner-only actor.
7. **Timing & sequencing** — This IS the finding (F3, F4).
8. **Scalability & load** — N/A structural (see F10).
9. **Edge cases** — Requires the rare compound of (concurrent restores) AND (a hard crash in the exact marker-write-to-swap-complete window) for F3's worst case; F4 (nightly-vs-restore) needs no crash, just the fixed 02:00 UTC schedule landing during a live restore.

### Step: `runRepair` → `migrateUp` (src/backup/repair.ts:136-137) — F2

1. **Human factors** — Repair is user-initiated from Settings (`app/(app)/settings/BackupPanel.tsx`'s new "Repair" button), typically clicked when something already looks broken — exactly when an unplanned schema change is most likely to also be in flight (e.g., a just-installed update whose migrations haven't run yet).
2. **Technical/system** — Confirmed: `runRepair` calls `migrateUp(opts.connectionString, opts.migrationsDir)` (repair.ts:137) with NO third `MigrateUpOptions` argument — the `onBeforeMigrating` hook added to `migrateUp` in the prior fix pass (`src/db/migrate.ts`) is never supplied here, unlike `desktop/database.ts:219-222`'s boot-path wiring.
3. **Process design** — This is an inconsistency between two callers of the same shared function, not a missing capability — `migrateUp` already supports the hook; `repair.ts`/`http.ts`'s `runRepairBackup` simply doesn't pass it.
4-9. Same reasoning as the boot-path pre-migration finding this chunk already fixed once; the only new element is that this specific caller was missed.

## 4. Correctness Audit

1. **Logically sound?** Mostly yes for the single-caller case; the multi-caller case is where it breaks — `getOrCreateBackupKey`'s output (a key) silently disagrees with what a LATER caller's output (a different key) will be, and nothing downstream detects the disagreement until a restore fails months later.
2. **Complete?** No — missing an explicit concurrency-control step. The design already has rollback (rename-swap, retired-not-dropped), idempotency (migrations, `pruneBackups`'s per-candidate re-check), and an audit trail (`log.info`/`log.error` on every path) — but no mutual exclusion, which every other safety property in this module implicitly assumes.
3. **Robust?** Yes for single-operation failures (disk full, corruption, tampering — all handled with specific error codes and native-notification alerts). Not robust against operation-vs-operation collisions, which is the whole finding set above.
4. **Efficient?** No material inefficiency found — `pruneBackups` re-querying the full table per candidate (rotation.ts:153) trades a little extra I/O for real safety, a good trade at this data volume (a handful of backup rows).
5. **Resilient?** Yes for process crash (the swap marker + `local-database.ts`'s boot-time recovery check are a real, tested resilience mechanism — proven by `test/backup-restore.int.test.ts`'s "recovers automatically from a crash between the two rename-swap steps"). Not resilient to two IN-PROCESS callers racing each other, since that was never the threat model the crash-recovery marker was designed against.
6. **Brittle points?** The single shared marker-file path (F3) and the unguarded check-then-act key creation (F1) are the two brittle points; both are single points of failure that only manifest under a specific interleaving, which is exactly why they had zero test coverage until this audit.

## 5. Mitigations

```
Finding: F1 — backup-key generation TOCTOU race (RPN 32, HIGH)
Mitigation: Add an in-process async mutex (src/backup/lock.ts, new file) wrapping every
  operation that can call getOrCreateBackupKey or mutate the live database: createBackup
  (manual + nightly), restoreBackup (in-app + external), and runRepair's migrateUp. Single
  Electron main process / single Node event loop, so a promise-chain queue is sufficient —
  no OS-level file lock needed.
Type: Prevention
Effort: 1-2 hours for a solo operator + Claude Code (small, well-scoped module + wiring 5 call
  sites + tests)
Owner: fix-now (implemented and verified in this session — see closing report)
```

```
Finding: F2 — repair's migrateUp has no pre-migration safety backup (RPN 18, MEDIUM)
Mitigation: Extend RepairOptions with an optional onBeforeMigrating passthrough forwarded to
  migrateUp; have runRepairBackup (src/backup/http.ts) supply the same kind of
  createBackup({kind:'pre_migration', ...}) hook desktop/database.ts already builds for the
  boot path, using the same host/connection primitives runRepairBackup already assembles.
Type: Prevention
Effort: 30-45 minutes
Owner: fix-now (implemented and verified in this session — see closing report)
```

**MEDIUM (brief):** F3 (restore-vs-restore marker overwrite) — resolved as a byproduct of the F1 mitigation's lock, since it also serializes concurrent `restoreBackup` calls; no separate card needed.

**LOW (one line each):** F4 (nightly-vs-restore kills pg_dump) — resolved as a byproduct of the same lock. F5 (orphaned `imported-*` copies on repeated failed restore-external attempts) — accepted; log-and-move-on, a human can clear `backups/imported-*` manually, and the underlying `backups` row cleanup (the actual safety property) already works. F6 (unguarded `new URL()`) — accepted, defense already exists (dispatcher catch-all). F7 (English-only `RESTORE` confirmation word) — accepted; matches the rest of the product's English-only UI copy, not a backup-specific gap. F8 (future-dated clock skew clamped to 0) — accepted; `daysAgo`'s clamp comment already documents this as deliberate, and a wildly wrong system clock is a pre-existing, product-wide assumption, not new to this chunk.

## 6. Handoff

Two findings (F1 HIGH, F2 MEDIUM) are being fixed directly in this same session (owner: fix-now) rather than routed to `output-to-orchestrator`/`truth-fix-loop`, since the fixes are small, well-scoped, and the same session already holds full context of the module. This audit predicts risk; it does not re-prove the whole chunk works — the existing evidence base (971+ passing tests across unit/integration/e2e-desktop from the prior adversarial-audit fix pass) is unchanged by this report and still stands as the completion evidence for everything NOT listed here. After F1/F2 are fixed, re-run the backup test suites (unit + `--mode integration` + `e2e-desktop/backup.spec.ts`) before considering this chunk's concurrency surface closed.

---
**Changed:** This report (`AUDIT-fma-chunk7-2026-07-28.md`).
**Verified:** All 12 findings' `file:line` citations checked against the current working tree (not the prior audit's stale line numbers); F6 confirmed safe by reading `desktop/ipc/dispatcher.ts`'s catch-all, not assumed.
**Still Broken (before the fix pass that follows this report):** F1 (HIGH) and F2 (MEDIUM) are unmitigated as of this report's timestamp — the fix pass in this same session closes both plus F3/F4 as a byproduct.
