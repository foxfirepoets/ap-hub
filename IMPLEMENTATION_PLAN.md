# Implementation Plan — AP-Hub Local Desktop Shell (Windows-only Version 1)

> **SCOPE: WINDOWS ONLY** — `docs/decisions/windows-only-v1-2026-07-25.md` is authoritative.
> macOS packaging, signing, notarization and acceptance criteria are out of Version 1.
> The macOS abstractions are preserved and must keep compiling.

Spec: `specs/SPEC-local-desktop-shell.md`
Architecture: `architecture-decision-packet-ap-hub-local-desktop-2026-07-25.md`
Migration evidence: `docs/audits/electron-migration-inventory-2026-07-25.md`

Tasks are ordered by dependency. Each checkbox is one independently committable
continuous-build-verify task and must finish with `npm run verify` unless it also names an
installed-environment validation.

> **Carried forward from the archived `cbv-loc001` build:** commits `78c5522`, `eb150e0`, `fef9d43`
> are retained. They implement Windows Credential Manager storage, the credential-reference schema
> (`migrations/013`) and legacy-secret migration — all of which the desktop architecture still uses.
> The archived CHUNK_2 loopback HTTP session work is **not** carried forward; IPC removes the need.

## CHUNK_1_SHELL — Electron shell

- [x] Add Electron and electron-builder; create `desktop/main.ts`, `desktop/preload.ts`, and the build config. Wire a single-instance lock, window lifecycle, and a tray icon with Open / Pause / Resume / Quit.
- [x] Harden the renderer: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, a CSP with no remote origins, blocked navigation to non-`file://` origins, and `shell.openExternal` limited to the four provider domains. Prove `window.require`, `window.process` and `window.module` are undefined from renderer JavaScript.
- [~] **DEFERRED TO CHUNK_3** (DEVIATIONS.md #4): static-export the existing React tree into the renderer and load it. Change no page component. `next build --output export` refuses to run while `app/api/**` exists, and CHUNK_3 is the chunk that deletes those 52 routes. CHUNK_1 ships `desktop/boot.html` instead, which is also the `DB_STARTING` surface. The spec's CHUNK_1 exit criterion (§18) is met and proved by `e2e-desktop/shell.spec.ts`.
- [x] Run `npm run verify` plus a Playwright renderer-hardening assertion, record artifacts in `.ralph/progress.md`, then append `<promise>CHUNK COMPLETE: CHUNK_1_SHELL</promise>`.

## CHUNK_2_DATABASE — Bundled invisible PostgreSQL

- [x] ~~Spike both candidate distributions (Open Question 1).~~ **DONE** — `docs/audits/postgres-bundling-spike-2026-07-25.md`. Chosen: official PostgreSQL Windows binaries trimmed to `bin`+`lib`+`share`.
- [x] Bundle the chosen PostgreSQL 16 Windows runtime with a reproducible trim script.
- [x] Start PostgreSQL as a supervised child with a private data directory, probing ports from 55432 upward; never connect to or modify an existing instance on 5432. Record the chosen port in `install.json`.
- [x] Add `migrations/014_local_install.sql` and `015_backups.sql` with tested DOWN scripts; run migrations automatically at launch inside a transaction, leaving the previous version usable on failure.
- [x] Add `test/db-bootstrap.test.ts` covering occupied 5432, occupied 55432, a fresh data directory reaching head, and UP → DOWN → UP.
- [x] Run `npm run verify`, record artifacts, then append `<promise>CHUNK COMPLETE: CHUNK_2_DATABASE</promise>`. — closed 2026-07-26; promise line appended to `.ralph/progress.md`.

## CHUNK_3_IPC — Replace 52 HTTP routes with IPC

- [ ] Build one IPC dispatcher mapping `aphub:<domain>:<action>` channels to the same `src/services/**` entry points the routes call, reusing `runRead` / `runAction` / `runApprove` with a synthesized context. Validate every payload with the existing zod schemas.
- [ ] Swap the transport in the only two renderer files that perform network I/O: `app/lib/api.ts` and `app/lib/session.tsx:31`.
- [ ] Delete the 528 lines of `app/api/**/route.ts`. Report any route that instead needed the embedded-Next fallback rather than silently widening scope.
- [ ] Add `test/ipc-contract.test.ts` replaying the full cross-tenant and RBAC matrices from `test/f5-cross-tenant-isolation.test.ts` against every channel; add a Playwright assertion of zero AP-Hub HTTP requests from the renderer.
- [ ] Run `npm run verify`, record artifacts, then append `<promise>CHUNK COMPLETE: CHUNK_3_IPC</promise>`.

## CHUNK_4_IDENTITY — OS-account owner identity

- [ ] Add OS-account identity (Windows SID) to `src/host/types.ts` and `src/host/windows.ts`; write non-secret `install.json` and reject any key whose name or value resembles a credential. (macOS adapter keeps compiling; out of V1 scope.)
- [ ] Make the OS account holder the owner; remove Google SSO as the product entry point in `app/login/page.tsx` and `src/auth/**` while preserving all tenant and role authorization.
- [ ] Add `test/local-install.test.ts` proving cross-account separation, the plain-language explanation for a second OS account, and OS-account mismatch failing closed.
- [ ] Run `npm run verify` plus a two-account manual check, record artifacts, then append `<promise>CHUNK COMPLETE: CHUNK_4_IDENTITY</promise>`.

## CHUNK_5_CONNECT — Provider login without a browser tab the user manages

- [ ] Open provider consent in the **system browser** via `shell.openExternal`; never an embedded webview.
- [ ] Implement the single-use loopback callback on an ephemeral port with exact redirect-URI match, S256 PKCE, random state, ten-minute expiry, and listener close immediately after exchange; return focus to the AP-Hub window.
- [ ] Store tokens through the existing credential store; PostgreSQL keeps references and non-secret metadata only.
- [ ] Run `npm run verify` plus a live Gmail connect against a disposable account, record artifacts, then append `<promise>CHUNK COMPLETE: CHUNK_5_CONNECT</promise>`.

## CHUNK_6_CLEANUP — Remove hosted and technical surfaces

- [ ] Remove `BROKER_BASE_URL` and `BROKER_INSTALL_TOKEN` from `src/config.ts` and `.env.example`; delete broker branches in `src/extract/model.ts`, `src/services.ts` and `src/telemetry.ts`, keeping the direct and local-runtime paths.
- [ ] Default `SWARMSYNC_ENABLED` to false; implement the three disabled/unavailable rules (packet §5) and extend `proof_fail_safe` with the required-by-policy and never-label-verified cases.
- [ ] Replace `app/lib/onboardingErrors.ts` with exhaustive plain-language mapping and **delete the raw-message fallback**; add `test/error-mapping.test.ts` asserting no raw fallback path exists.
- [ ] Add `test/no-hosted-dependency.test.ts` proving zero `BROKER_` references and no AP-Hub https origin in any runtime path.
- [ ] Run `npm run verify`, record artifacts, then append `<promise>CHUNK COMPLETE: CHUNK_6_CLEANUP</promise>`.

## CHUNK_7_BACKUP — Encrypted backup, verified restore, repair

- [ ] Implement scheduled, pre-migration and pre-update backups: consistent PostgreSQL dump plus document store, taken without stopping the engine, encrypted with a key held only in the OS credential store.
- [ ] Verify every backup by re-reading it and checking a manifest hash and row counts. **An unverified backup is reported as failed and never counted.** Rotation (7 daily / 4 weekly / 3 monthly + pre-update) must never prune the last verified copy.
- [ ] Add one-click restore and repair mode, plus exportable backup and an optional user-nominated external folder (OneDrive, Drive, Dropbox, network share, external drive) — user-selected, never automatic, never an AP-Hub location. State the machine-bound-key limitation plainly in the export copy (Open Question 3).
- [ ] Add `aphub:backup:list` and `aphub:backup:restore` IPC channels, owner-only, never returning the key. Surface backup health in Settings and raise a visible warning plus a native notification on failure.
- [ ] Add `test/backup.test.ts` and `test/backup-restore.int.test.ts` proving the destroy-and-restore drill: back up → drop the schema → restore → document counts, audit rows and postings match exactly.
- [ ] Run `npm run verify` plus the destroy-and-restore drill, record artifacts, then append `<promise>CHUNK COMPLETE: CHUNK_7_BACKUP</promise>`.

## CHUNK_8_SUPERVISION — Continuous operation on both platforms

- [ ] Implement autostart: per-user Task Scheduler on Windows, non-elevated. Sequence PostgreSQL readiness, then the engine, then the window.
- [ ] Restore killed children within 90 seconds; stop after five failures in ten minutes with a plain-language message and a support-export action.
- [ ] Handle sleep, wake and network loss with durable cursor and job resumption and no duplicate work; rotate logs at 10 MiB / 10 files; add native OS notifications for crash-loop, disk-full, backup-failed and reconnect-needed.
- [ ] Run `npm run verify` plus child-kill, reboot, sleep/wake and network-loss drills on Windows, record artifacts, then append `<promise>CHUNK COMPLETE: CHUNK_8_SUPERVISION</promise>`.

## CHUNK_9_PACKAGE — Signed installers and clean-machine certification

- [ ] Produce a Windows NSIS installer, non-admin, installing every component silently. No Authenticode certificate is available: ship an **unsigned internal release candidate** plus signing-ready configuration, artifact SHA-256, build manifest and the exact future signing command. (macOS DMG out of V1 scope.)
- [ ] Implement uninstall with an explicit user choice about data, and repair that reinstalls components without touching user data.
- [ ] Execute the clean-machine test plan on the strongest available clean Windows environment with no Node, PostgreSQL, Docker or Git: listener inspection, cross-account isolation, reboot and child-kill drills, destroy-and-restore, external-folder restore, tampered-update refusal, SmartScreen friction recorded.
- [ ] Reconcile `README.md`, `INSTALL.md`, `AGENTS.md` and all UI copy with observed behavior, stating every remaining limitation.
- [ ] Run `truth-fix-loop` then `spec-vs-build-brutal-audit` against `specs/SPEC-local-desktop-shell.md`; require zero P0/P1 defects and an artifact per acceptance criterion before appending `<promise>CHUNK COMPLETE: CHUNK_9_PACKAGE</promise>`.

## CHUNK_10_XERO_CONNECTOR — Real Xero accounting connector (added 2026-07-28; spec: `specs/10_CHUNK_10_XERO_CONNECTOR.md`)

> Pulled into V1 scope by the 2026-07-25 scope expansion (`specs/SPEC-local-desktop-shell.md:98-108`).
> Grounded in `docs/audits/architecture-map-2026-07-28.md` and a fresh Xero API deep-research pass
> (2026-07-28). All three open questions in the spec are resolved by the owner — status: Ready for
> Build, not blocked.

- [x] Implement `src/connectors/xero.ts` (`createXeroConnector()`) for real on the official `xero-node` SDK — full `AccountingConnector` interface, no `NotImplementedInPhase`. Replace the stub export in `src/connectors/index.ts`/`factory.ts`. Never the Xero MCP server (built for AI tool-calling, not backend integration).
- [x] OAuth: PKCE against a Desktop-app-type Xero client, new granular scopes only (never the old broad scopes — unavailable to apps created after 2026-03-02). New `XERO_CLIENT_ID` config var (no secret — PKCE desktop clients hold none), per-customer bring-your-own-app (owner-confirmed 2026-07-28). Widen `src/auth/connect-loopback.ts`'s `ConnectProvider` to include `'xero'`.
- [x] Idempotency-Key header (UUID) on every write; vendor provisioning via plain Contacts (never sets the read-only/derived `IsSupplier` flag); dimensions capped at Xero's real 2-active-Tracking-Category ceiling with any excess surfaced as `Unsupported` (audited, never dropped) — mirror `qbo.ts`'s `gapsFor` pattern exactly.
- [x] Every create/postBill followed by authoritative `readBack`/`readBackVerify` using `UpdatedDateUTC` as revision; malformed/partial read-back = failure = hold, never marked posted. `verifyCompanyIdentity` refuses posting before the connected org matches config. New `XERO_PRODUCTION_WRITE_ENABLED` gate, default false, mirroring `QBO_PRODUCTION_WRITE_ENABLED` exactly.
- [x] Generalize `src/pipeline/posting.ts`'s `postSandboxHandler` off its current hardcoded `getQboConnector` import: add `getConnectorForProvider(tenantId)` to `src/connectors/factory.ts` (reads the tenant's `connections` row — the simpler of the two designs considered, owner-confirmed 2026-07-28), and generalize the QBO-specific production-write gate check in the same handler. Required updating `architecture-connector-path.test.ts`'s literal-string assertion from `getQboConnector` to `getConnectorForProvider`, owner-approved 2026-07-29 (see `.ralph/state.md`/`.ralph/errors.log`).
- [x] Move Xero out of `test/connector-contract.test.ts`'s "stubs throw" block and into its own `runConnectorContract('xero', ...)` call, in the same PR as the implementation (not a follow-up — the existing test correctly fails the moment the stub stops throwing).
- [x] Confirm `npm run lint:noleak` passes with zero new exceptions (no Xero-specific identifier outside `src/connectors/**`); correct the stale comment at `desktop/channels.ts:54-56`.
- [x] Where a live Xero test-org connection is unavailable at build time, everything up to that boundary ships proven against a mocked `xero-node` client; the external "posted a real bill, read back and confirmed" proof is logged as **UNVERIFIED — awaiting Xero test-org credentials**, never silently claimed done.
- [x] Run `npm run verify`, record artifacts, then append `<promise>CHUNK COMPLETE: CHUNK_10_XERO_CONNECTOR</promise>`.

**Verification artifacts (2026-07-29):** `npm run verify` full chain green in one uninterrupted run — lint clean, `lint:noleak` clean, `tsc --noEmit` clean, vitest 86/86 files / 1812/1812 tests passing (including all 5 protected safety tests and the new `runConnectorContract('xero', ...)` suite), `web:build` clean, Playwright `test:ui-contract` 54/54 desktop e2e passing. Two transient environment issues hit during this verification (stale Electron single-instance lock and a stale cross-process test-DB lock, both left over from an earlier interrupted run) were diagnosed to root cause, cleared, and independently re-verified as not code defects before the final clean run.

**Known non-blocking gaps carried forward (not in this chunk's scope):** no Xero token-refresh mechanism yet (30-min access-token expiry — OAuth exchange only); `postSandboxHandler`'s `expectedCompanyName` is still hardcoded to `cfg.QBO_SANDBOX_COMPANY_NAME` regardless of which provider actually resolved, which will misfire `company_mismatch` holds for real Xero postings; `src/auth/connect-state.ts`'s `ConnectProvider` type (`'gmail' | 'qbo'`) is narrower than `src/auth/connect-loopback.ts`'s (includes `'xero'`) — currently harmless since nothing calls `createConnectState` with `'xero'` yet, but should be unified before Xero connect is exposed in the UI.

<promise>CHUNK COMPLETE: CHUNK_10_XERO_CONNECTOR</promise>
