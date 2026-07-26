# Progress Log (append-only)

Project: ap-hub-windows-local-only
Initialized: 2026-07-25
Total chunks: 7

## Log

(no entries yet)

### 2026-07-25 — Planning

Read the frozen Windows local-only specification, all seven generated chunk
specifications, project commands, and Ralph guardrails. Created the dependency-ordered
CBV task plan in `IMPLEMENTATION_PLAN.md`; no application code or tests were written.

<promise>PLANNING COMPLETE</promise>

### 2026-07-25 — Iteration 1 — CBV-LOC001

Implemented migration 013 for non-secret Windows Credential Manager references and
constrained QuickBooks transport metadata. PostgreSQL rejects malformed credential
targets and recursively rejects secret-bearing metadata/configuration. DOWN now
refuses while credential references or configured transport modes remain.

Verification:

- Focused migration UP → DOWN → UP/schema/constraint/rollback test: passed.
- `npm run verify`: exit 0.
- Unit suite, production web build, and 24 Playwright UI contracts: passed.
- Commit: `16db0b8 feat: add local credential schema cbv-loc001`

<promise>TASK_COMPLETE</promise>

### 2026-07-25T09:14:14-07:00 — CBV-LOC001 Task 1 terminal verification

- Commit: `78c5522`
- Independent `npm run verify`: exit 0 in 605.5 seconds.
- Gate evidence: lint, no-leak scan, typecheck, 64 files / 484 tests, production web build, 24/24 Playwright.
- Truth-fix audit: `GREEN_COMPLETE` after 168 actual hostile database operations, seven positive controls, and direct DOWN → UP lifecycle proof.
- Earlier aggregate verification timeout was superseded by the successful exact-SHA rerun.

<promise>TFL GREEN: CBV-LOC001 TASK 1</promise>

### 2026-07-25 — Iteration 5 — CBV-LOC001 final whitespace/case truth-fix

Closed leading/trailing ASCII whitespace, control-character, and mixed-case matching
bypasses in the centralized non-secret text validator. Every anchored credential-shape
check now uses the same trimmed value and case-insensitive matching where appropriate.
Provider account identifiers reject surrounding whitespace/control characters while
retaining common Gmail email/opaque identifiers and numeric QBO realms.

Actual INSERT coverage includes leading/trailing spaces, tabs, newlines, mixed-case
Google/GitHub/sk credential forms, and JWT variants across every credential metadata
string/array channel. Legitimate email, opaque, scope, timestamp, and numeric-realm
controls remain accepted.

Verification:

- Focused migration whitespace/case/value/schema/rollback matrix: passed.
- `npm run verify`: exit 0.
- Production web build and 24 Playwright contracts: passed.
- Amended commit: `78c5522 feat: add local credential schema cbv-loc001`

<promise>TASK_COMPLETE</promise>

### 2026-07-25 — Iteration 4 — CBV-LOC001 value-channel truth-fix

Closed plaintext value channels inside otherwise allowed JSON fields. Migration 013
now centrally rejects authorization headers, JWT-shaped values, common API/private-key
prefixes, PEM material, and suspicious long high-entropy strings. Free-form
`last_refresh_status.message` was removed. Refresh state is a bounded enum, and
endpoint/command identifiers require the documented `registered-*` namespace.

Actual INSERT/UPDATE tests cover every allowed string and scope/tool-array surface
with bearer, JWT, API-key, PEM, and entropy-shaped values. Positive controls retain
Gmail scopes, provider account IDs, numeric QBO realms, registered transport
references, tool names, and company identifiers.

Verification:

- Focused migration value-channel/schema/rollback matrix: passed.
- `npm run verify`: exit 0.
- Production web build and 24 Playwright contracts: passed.
- Amended commit: `40722d1 feat: add local credential schema cbv-loc001`

<promise>TASK_COMPLETE</promise>

### 2026-07-25 — Iteration 3 — CBV-LOC001 strict-schema truth-fix

Replaced denylist-based JSON inspection with strict database schemas. Credential
metadata now accepts only bounded scope, expiry, provider-account, and refresh-status
fields with explicit types. Connection configuration is validated by transport mode
and accepts only bounded non-secret identifiers, allowlisted tools, and timeouts.
Unknown keys are rejected recursively.

Hostile tests cover bearer, authorization, OAuth, client/signing keys, passphrases,
password abbreviations, auth, generic keys, refresh/session/certificate terms, and
randomized punctuation/casing/nesting on both protected JSON columns. Positive
controls cover documented metadata and every current transport mode.

Verification:

- Focused migration schema/rollback/hostile matrix: passed.
- `npm run verify`: exit 0.
- Production web build and 24 Playwright contracts: passed.
- Amended commit: `b394ad3 feat: add local credential schema cbv-loc001`

<promise>TASK_COMPLETE</promise>

### 2026-07-25 — Iteration 2 — CBV-LOC001 truth-fix

Closed the migration 013 JSON-key normalization bypass found by the independent
truth-fix audit. Keys are normalized by removing non-alphanumeric separators before
rejecting token, secret, password, credential, API-key, access-key, and private-key
forms. Hostile nested object/array coverage now includes snake_case, kebab-case,
camelCase, PascalCase, and concatenated variants for both credential metadata and
connection transport configuration. Safe metadata/configuration controls remain valid.

Verification:

- Focused migration hostile matrix and UP → DOWN → UP test: passed.
- `npm run verify`: exit 0.
- Production web build and 24 Playwright contracts: passed.
- Amended commit: `978935e feat: add local credential schema cbv-loc001`

<promise>TASK_COMPLETE</promise>

### 2026-07-25 — CBV task 2 — Windows Credential Manager secret store

Replaced the Windows DPAPI-file secret backend with a current-user Windows Generic
Credential implementation backed by the native Advapi32 Credential Management APIs.
The host contract now validates strict `APHub/...` targets and supports put, get,
idempotent delete, and target listing without placing secret values in command lines,
environment variables, files, browser storage, logs, or surfaced errors.

Verification:

- Host contract: 6/6 passed.
- Windows-only native Credential Manager integration: 1/1 passed with randomized
  target cleanup.
- UI contract: 24/24 passed on an isolated configurable port.
- `APHUB_E2E_PORT=34123 npm run verify`: exit 0.

<promise>CBV_BUILD_COMPLETE: Windows Credential Manager secret store</promise>

### 2026-07-25T10:03:01-07:00 — CBV-LOC001 Task 2 terminal verification

- Commit: `eb150e083b58e8c383d6aafe5fb0328c253bf29a`
- Independent `APHUB_E2E_PORT=35371 npm run verify`: exit 0 in 457.6 seconds.
- Gate evidence: lint, no-leak scan, typecheck, 64 files / 485 tests, production web build, 24/24 Playwright.
- Real Windows Credential Manager integration proved exact UTF-8 limits, current-user storage, target isolation, overwrite/delete behavior, redacted failures, and cleanup.
- Truth-fix audit: `GREEN_COMPLETE`.

<promise>TFL GREEN: CBV-LOC001 TASK 2</promise>

### 2026-07-25 — Workspace re-scaffolded for the local desktop direction

`spec-to-ralphprep specs/SPEC-local-desktop-shell.md` run in **merge** mode against the existing
workspace. Nothing was overwritten that had already been reconciled.

Preserved verbatim (not touched):
- `.ralph/guardrails.md` — including the email carve-out and the discovery/backup SIGNs
- `.ralph/state.md`
- `IMPLEMENTATION_PLAN.md`
- this log's prior history

Written or reconciled:
- `specs/01_CHUNK_1_SHELL.md` … `specs/09_CHUNK_9_PACKAGE.md` — nine chunk specs (were missing)
- `AGENTS.md` — removed the `docker compose up -d db` step (Docker is out of scope in this
  direction); added the Electron commands and the new devDependencies note; `## Validation
  Commands` heading and single-line gate kept intact
- `PROMPT_plan.md` — repointed from the archived 7-chunk local-only specs to the nine local-desktop
  chunk specs; promise tag corrected to `PLANNING_COMPLETE` (underscore) per the ralph contract
- `PROMPT_build.md` — replaced the blanket "never … send email" instruction with the locked-
  forwarder carve-out, which requires **exactly one** send site and treats zero as a defect
- `README.ralph.md` — rewritten for the nine local-desktop chunks

Header note: this log's original header reads "Project: ap-hub-windows-local-only / Total chunks: 7".
That is historical. The current project is **ap-hub local desktop (Phase P1), 9 chunks**. The header
is left in place because this file is append-only.

<promise>PLANNING_COMPLETE</promise>

### 2026-07-25 — CHUNK_1_SHELL — Electron shell

Built the Electron main process, the frozen preload bridge, the hardened renderer, the tray and
the single-instance lock. Electron 33.4.11 + electron-builder 25.1.8 + esbuild 0.28.1 added as
devDependencies (recorded in AGENTS.md per the standing guardrail).

Files added: `desktop/{main,preload,channels,security,status}.ts`, `desktop/boot.html`,
`desktop/assets/tray.png`, `desktop/entitlements.mac.plist`, `scripts/build-desktop.mjs`,
`electron-builder.yml`, `test/desktop-shell.test.ts`, `e2e-desktop/shell.spec.ts`.

Design notes:
- The preload is **bundled** (esbuild → CJS). A sandboxed preload cannot `require` a relative
  module, so without bundling the channel allowlist would be re-typed inside the preload and
  drift from `desktop/channels.ts`. Main is ESM because it resolves its own dir via
  `import.meta.url`.
- The channel allowlist is enforced **twice** — preload and `ipcMain`. The spec requires
  enumeration at preload only; the second check means a preload compromise cannot widen the
  surface.
- Security logic lives in pure modules so the gate asserts the *properties* (CSP names no remote
  origin, `connect-src 'none'`, an unregistered-but-well-formed channel is still refused, no tray
  label contains a technical word) rather than asserting an options object was constructed.

Verification:

- `npm run verify`: **exit 0**.
- Gate evidence: lint (now covering `desktop/**`), no-leak, typecheck, **65 test files passed**
  (was 64 — `test/desktop-shell.test.ts` 17/17 added), production web build, **31 Playwright
  passed** (was 24 — 7 desktop runtime assertions added).
- Runtime proof against a real Electron process (`e2e-desktop/shell.spec.ts`): `window.require`,
  `window.process`, `window.module`, `window.global`, `window.Buffer` all `undefined`; the
  bridge is frozen and cannot be reassigned; an unregistered channel is refused without echoing
  the channel name; `fetch('https://example.com')` is BLOCKED by CSP; zero network requests.
- **No existing test was modified** — `git diff --name-only HEAD -- test/ e2e/` is empty. All
  changes are additive.
- Locked-forwarder scan: **exactly one** provider-send call site (`src/gmail/adapter.ts:142`),
  reachable only via `createLockedForwarder`. Not zero, not two.

Deviation recorded (DEVIATIONS.md #4): the renderer **static export** moves from CHUNK_1 task 3
to CHUNK_3. `next build` with `output: 'export'` refuses to run while `app/api/**` exists, and
those route files are CHUNK_3's to delete. The spec's own CHUNK_1 exit criterion — an empty
window from an icon with `window.require` undefined — is met and proved.

NOT verified, and not claimed:
- **macOS.** No macOS machine is available in this environment. `desktop/` is
  platform-neutral and the electron-builder mac target is configured, but nothing was built,
  signed, notarized or launched on macOS. The CHUNK_1 exit criterion says "on both platforms";
  only Windows is evidenced.
- Packaged-installer behavior (CHUNK_9 owns it) — the shell was exercised unpackaged.

<promise>CHUNK COMPLETE: CHUNK_1_SHELL</promise>

### 2026-07-25 — CHUNK_2_DATABASE — PARTIAL (promise NOT appended)

**Open Question 1 resolved with measured numbers** — full workings in
`docs/audits/postgres-bundling-spike-2026-07-25.md`.

| Metric | A: official binaries | B: embedded-postgres |
|---|---|---|
| Shippable subset (bin+lib+share) | 119.6 MB | 99 MB |
| initdb (first launch only) | 11,820 ms | 14,455 ms |
| Total first launch | 12,755 ms | 14,838 ms |
| Warm start → query | 726 ms | 691 ms |
| Release channel | stable | **beta only, every version** |

Decision: **candidate A**, trimmed to bin+lib+share (the full 919.8 MB download is 87%
pgAdmin/symbols/doc, none of which ships). Decided on release channel first — `embedded-postgres`
has never shipped a stable release across its 16.x, 17.x or 18.x lines, and this component holds
the user's entire AP history — and on first-launch headroom second: against the ≤15 s cold-launch
budget A leaves 2.2 s and B leaves 0.2 s, before Electron/engine/migrations take their share.
Honest counter-argument recorded: B is clearly better on macOS (free platform binaries via
optionalDependencies); revisit for the macOS target specifically if sourcing a relocatable macOS
build proves hard in CHUNK_9.

Done:
- `migrations/014_local_install.sql` + `.down.sql`, `migrations/015_backups.sql` + `.down.sql`.
  Verified against the live database: singleton CHECK enforced (23514), db_port range enforced,
  platform enum enforced, verified/unverified backups distinguishable, UP → DOWN → UP green.
- `src/db/bootstrap.ts` — port probe from 55432 upward, 5432 additionally refused outright,
  bounded search, binds 127.0.0.1 explicitly (never 0.0.0.0, which would briefly expose a port
  on every interface). `test/db-bootstrap.test.ts` 11/11, holding real sockets open rather than
  mocking the answer being discovered.

**ESCALATED AND RESOLVED BY THE OWNER:** adding 014/015 broke
`test/accounting-intake-migration.test.ts`, which is structurally coupled to 013 being the head
migration (`migrateDown` pops exactly one). The standing rule forbids editing an existing safety
test; spec §13 names that same file as where the new migrations' UP → DOWN → UP must be proven.
Stopped and escalated rather than deciding. Owner chose the additive extension. Result:
**43 insertions, 0 deletions** — no existing assertion weakened, deleted or changed, and the new
cycle spec §13 asks for is now proven there.

NOT done — CHUNK_2 is genuinely incomplete:
- PostgreSQL is not bundled into the installer; no trim script exists yet.
- No supervised PostgreSQL child, no private data directory.
- The probed port is not yet written to `install.json`.
- Migrations are not yet wired to run automatically at launch.

Verification: `npm run verify` **exit 0**. 66 test files (was 65), 31 Playwright.
Locked forwarder: **exactly one** provider-send call site. Not zero.

Environment note found while measuring: this machine already runs two PostgreSQL instances —
a scoop install on 5432 and the archived `cbv-loc001` build's bundled instance on 55432
(`%LOCALAPPDATA%\APHub\bin\pgsql`, PostgreSQL 16.4). Both ports the spec's collision test cares
about are genuinely occupied here, which is a useful fixture for CHUNK_2's remaining work. That
install root also contains a `.env` and a `secrets/` directory from the old design, which spec §9
now forbids — outside the repo, but relevant to CHUNK_9's uninstall/repair story.

### 2026-07-26 — CHUNK_2_DATABASE — CLOSED (supersedes the PARTIAL entry above)

The `2026-07-25 — CHUNK_2_DATABASE — PARTIAL` entry above is **historical and superseded**. It is
left unedited because this log is append-only. Everything its "NOT done" list named was completed
by the four commits that followed it:

| Commit | What it closed |
|---|---|
| `3eee57b` | recorded the remaining CHUNK_2 work and the local port-collision fixture |
| `ccd2d3c` | `install.json` credential rejection + the supervised PostgreSQL runtime |
| `f3120a5` | Electron ESM packaging for the `pg` runtime (`packages: 'external'`) |
| `b68984c` | bundled PostgreSQL starts **and migrates** under a real Electron process |

Verified by the integration lead on 2026-07-26 at `b68984c` before opening CHUNK_3:

- `npm run verify` exits 0.
- 37/37 Playwright tests pass, of which **6** are bundled-PostgreSQL tests under a real Electron
  process (`e2e-desktop/database.spec.ts`): the shell reaches `running` with its private database
  ready; a real cluster exists in the install's private data directory; `install.json` records a
  private port and carries **no** credential; the database listens only on loopback on its own
  port; the migrated schema is reachable on that port with the stored password.
- `vendor/postgres.lock.json` `tree.fileCount` 1631 / `totalBytes` 125898162 matches the real
  `vendor/pgsql` tree exactly (measured, not asserted).
- Locked forwarder: **exactly one** provider-send call site, `src/gmail/adapter.ts:142`. Not zero.

Correction to the record: `.ralph/state.md` previously claimed this promise line had already been
appended. It had not — the claim was stale, the underlying work was real. Fixed here.

<promise>CHUNK COMPLETE: CHUNK_2_DATABASE</promise>

### 2026-07-26 — CHUNK_3_IPC — CLOSED

Closed by the integration orchestrator merging the final remainder from `agent/electron-renderer`
(`ca39e25`, merging `de2c8c8`) on top of the already-merged IPC dispatcher/read/action/renderer-
transport/contract-test work (`0ca28f2`, `c93e331`, `7a1f4a6`, `85fc2be`, `87517ce`).

Final remainder closed:
- All **54** route handlers deleted (52 `app/api/**` + 2 `app/oauth/*/callback`) — confirmed
  `app/api` and `app/oauth` no longer exist anywhere in the tree.
- Static export applied (`next.config.mjs` `output: 'export'`); the 3 runtime-id routes
  (`statements/[id]`, `transactions/[id]`, `settings/tax-mapping/[id]`) resolve via the
  sentinel-`layout.tsx` pattern (DEVIATIONS §5a option A) — 13 lines across 3 pages, 3 new
  10-line layout files, zero `href`/`router.push` call sites changed.
- `file://` path interception built in `desktop/main.ts` and proved under a **real** Electron
  process: `e2e-desktop/renderer.spec.ts` shows `/statements/<id>`, `/transactions/<id>` and
  `/settings/tax-mapping/<id>` each serving the exported placeholder page and resolving the real
  runtime id — the `[UNVERIFIED in real Electron]` flag from the freeze is now closed.
- The boot screen (`desktop/boot.html`) restored to subscribe to `aphub:status:engine`, with a
  new `e2e-desktop/boot-failure.spec.ts` (4 tests) proving a database that will not start shows a
  plain-language sentence with a next action, nothing technical reaches the screen, and the
  window never hands over to the app.
- All 24 legacy browser journeys from `e2e/app.spec.ts` migrated into `e2e-desktop/**`
  (`today.spec.ts`, `exceptions.spec.ts`, `gmail-drafts.spec.ts`, `tax-mapping.spec.ts`,
  `settings.spec.ts`, `statements.spec.ts`, `accessibility.spec.ts`), driving the real
  Electron/IPC transport via `app.evaluate` + `ipcMain.handle` overrides instead of
  `page.route` — no coverage dropped, no `fetch` fallback added. The one journey that inspected
  source paths (`reply draft surface contains no transmission control...`) now inspects
  `desktop/ipc/read/reply-drafts.ts` / `desktop/ipc/action/replyDrafts.ts` instead of the deleted
  route files, same assertion.
- `chromium` Playwright project, `scripts/serve-web-export.mts`, the `webServer` config block and
  `package.json`'s `web:start` script all removed — one `desktop` project remains.
- The renderer's zero-network-request property is asserted directly (`e2e-desktop/shell.spec.ts:94`,
  now also implicitly exercised across all 24 migrated journeys since none of them can reach a
  network origin through `window.aphub.invoke`).

**Independent re-verification by the integration lead** (not the authoring agent's self-report —
re-run personally, real captured exit codes, no piped `tail`):

- `npm run lint`: exit 0. `npm run lint:noleak`: exit 0. `npm run typecheck`: exit 0.
- `npm test`: exit 0 — **76 test files, 1557 tests** (was 75/1535 before this remainder; +1 file
  for the DB-failure test).
- `npm run web:build`: exit 0 — static export succeeds now that `app/api/**` is gone.
- `npm run test:ui-contract` (desktop build + Playwright): exit 0 — **47 passed, 0 skipped, 0
  failed** (23 pre-existing shell/renderer/database/boot-failure + 24 migrated journeys).
- `git diff --stat checkpoint/chunk3-start-b68984c -- src/`: empty. `src/**` is byte-identical
  through the entire chunk.
- One genuine type defect caught independently: the agent's self-reported `typecheck: EXIT:0` was
  real but incomplete evidence — `tsconfig.json`'s `include` never covered `e2e-desktop/**`, so a
  real `TS2322` in the newly-migrated `gmail-drafts.spec.ts` (assigning `externalDraftId: null`
  against an inferred `string` type) passed the project's own gate silently. Found via a scoped
  ad hoc tsc check (temporary tsconfig extending the real one with `e2e-desktop/**` + `dom` lib,
  deleted after use), fixed with a 1-line type-widen (`de2c8c8`), re-verified clean.

**Read-only security verification (Kraken)** — 9 of 10 checks PASS with direct evidence (route
deletion complete; IPC channels dispatch through the same `runRead`/`runAction` wrappers per
`docs/build/route-to-service-map.md`; the reply recipient deny-list is 11 fields in both
`src/services/action/index.ts` and `desktop/ipc/action/replies.ts`, with `test/ipc-action-domains.test.ts`
running one `it.each` case per field; exactly one provider-send call site,
`src/gmail/adapter.ts:131` inside `sendForward`, reachable only via `createLockedForwarder`,
recipient bound at construction with no caller-supplied recipient parameter;
`runMarkNotificationRead` still takes no role; no `min(1)` added to the write-gate strings;
`desktop/ipc/read/channels.ts` and `action/channels.ts` are bare zero-import `as const` arrays).

One safety test **was** touched — `test/desktop-shell.test.ts` (`a255ea2`): the exact-equality
channel-list assertion widened from `toEqual([...SHELL_CHANNELS])` to
`toEqual([...SHELL_CHANNELS, ...READ_CHANNELS, ...ACTION_CHANNELS])`. Judged acceptable: it stays
exact `toEqual` (not loosened to `toContain` or a length check) and correctly reflects the 50
channels CHUNK_3 legitimately added — the guarantee (the enumerated channel set is exactly what
the test says it is) is unchanged, only the enumeration grew to match reality.

**One finding recorded, not fixed, and deliberately NOT blocking this promise**: `src/index.ts` +
`src/http.ts` are a pre-pivot HTTP service (binds `127.0.0.1`, registers `src/auth/routes.ts`'s
OAuth callbacks and a QBO Desktop SOAP endpoint) that predates the Electron pivot (`e88a7e8`) and
was never archived the way the hosted key broker was (`archive/pre-local-desktop-20260725/broker/**`).
It is still wired to a live `npm run dev` script and exercised by `test/http-security.test.ts`.
It is **not** reachable from the packaged Electron app — `desktop/main.ts` never imports
`src/index.ts` — so it does not violate this chunk's acceptance criteria (the renderer's
zero-network-request property, proved above). But it does mean the broader claim "no product HTTP
listener remains" is true of the shipped binary and not true of the repo as a whole. Two
architecture docs (`docs/audits/architecture-map-2026-07-17.md`,
`docs/audits/architecture-map-2026-07-25.md`) still describe it as live current architecture.
**Recommended disposition**: archive `src/index.ts` + `src/http.ts` alongside the broker in
CHUNK_6_CLEANUP (which already owns "remove every hosted dependency and technical surface the
user could ever see"), or explicitly document why it is deliberately kept and repoint the two
architecture docs. Not CHUNK_3's scope; tracked here so it is not silently lost.

Standing environment blockers restated (not dropped): no macOS machine, no signing identities, no
clean VMs — every "on both platforms" claim above is Windows-only evidenced.

Locked forwarder: **exactly one** provider-send call site. Not zero. Merge commit: `ca39e25`
on `feat/local-desktop-p1`, pushed to `origin/feat/local-desktop-p1`.

<promise>CHUNK COMPLETE: CHUNK_3_IPC</promise>

### 2026-07-26 — CHUNK_4_IDENTITY — CLOSED

The Windows account that opens AP-Hub becomes its owner, with no password and no browser tab.
Google SSO removed as the product entry point; tenant/role authorization unchanged.

Built on `agent/identity-chunk4` (merge commit `4fcdd78` on `feat/local-desktop-p1`):
- `src/auth/local-signin.ts` + `desktop/local-signin.ts`: resolves or creates the OS account's
  own tenant + owner row, keyed by the Windows SID the host adapter already exposed
  (`src/host/windows.ts`'s `osAccountId()` — built in CHUNK_2, `WindowsIdentity::GetCurrent()
  .User.Value`, validated `^S-1-[0-9-]+$` — specifically anticipating this chunk's need). A
  disabled owner stays disabled. Session-cookie secret generated once into the OS credential
  store, never a `.env`.
- `src/db/local-database.ts`: an OS-account mismatch (file-recorded OR database-recovered
  identity) throws `OsAccountMismatch` and fails closed before any data is returned. A corrupted
  `install.json` is tolerated and the identity recovered from `local_install` instead of crashing
  the launch — install-file credential-shape rejection and `dbPort` 1024-65535 validation were
  already built in CHUNK_2 and reused unchanged.
- `src/auth/google-sso.ts`: the OAuth-initiating functions (`buildGoogleLoginUrl`,
  `exchangeCodeForProfile`, `loginWithGoogle`) deleted outright — their only callers were already
  removed in CHUNK_3. DB-only `activateUserForLogin`/`completeLogin` kept, still exercised by
  other tests.
- `app/login/page.tsx`: fallback-only screen for the rare case identity could not be confirmed —
  no Google button, "Try again" instead of a dead end. `app/components/OnboardingWelcome.tsx`:
  added the required per-account privacy sentence, verbatim from the spec.
- `src/config.ts`: previously boot-required env vars (`ENCRYPTION_KEY`, `GMAIL_CLIENT_ID/SECRET`,
  `GOOGLE_SSO_CLIENT_ID/SECRET`) made optional at boot — the standalone shell ships with no
  `.env` and must reach a working sign-in with nothing supplied.

**Process note, not a code note:** the authoring agent's own status reports were unreliable
twice — it ended its turn on an orphaned "I'll wait for the background task notification now"
message instead of a structured report, apparently after backgrounding its own verification
commands and then stopping before they returned. The integration orchestrator resumed it once
for missing acceptance criteria (legitimately still in progress at that point), then took over
verification directly rather than resuming a third time, per the standing "same delegation 3x
→ halt" rule. All verification below is the orchestrator's own, independently run.

**A genuine defect was caught during that independent verification, not by the agent or by
Kraken's read-only pass** — full detail in commit `7adf1d0`: `ensureSessionCookieSecret`'s guard
checked only truthiness (`if (process.env.SESSION_COOKIE_SECRET) return;`), so this checkout's
own leftover dev `.env` (`SESSION_COOKIE_SECRET=dev-only-change-me`, 18 characters) was silently
accepted as "already set." Real secret generation was skipped, and `src/config.ts`'s `min(32)`
schema validation failed much later, deep inside session creation — surfacing as an opaque
"database did not start" failure that had nothing to do with the database. Two more hard-won
verification lessons from this exact catch:

1. **A background task's own "completed, exit code 0" notification is not the command's exit
   code** — it can be the exit code of the LAST command in a chained invocation (here, `tail`,
   or a trailing `echo`). The captured `$?` written inside the log by the command itself is the
   only trustworthy number. This is the same class of error as "never read a gate result through
   `grep | tail`," one level higher up the tool stack, and it produced a false "green" reading
   here before the real `PW_EXIT:1` was found inside the log.
2. **A full-suite pass can mask a fresh-boot defect.** The 47/47 desktop Playwright pass recorded
   on `agent/identity-chunk4` before merge was real, but it ran the WHOLE suite in one Playwright
   invocation — an earlier spec file's successful Electron launch generates and persists a valid
   secret to the (machine-wide, not per-run) Windows Credential Manager, which every later spec
   file's fresh Electron launch then finds already present, masking a truly-fresh-install failure
   that only surfaced when `e2e-desktop/database.spec.ts` was run **alone**, first, with the
   dev `.env`'s bad value as the only thing in the environment. Isolate-and-rerun a subset of a
   passing suite when something about "first launch" or "fresh state" is being asserted — a
   full-suite green does not prove every file is independently green from cold.

Fixed with a length check (`>= 32`, not mere truthiness). A new regression test,
`e2e-desktop/session-secret-recovery.spec.ts`, forces a too-short `SESSION_COOKIE_SECRET`
directly into the launched Electron process's environment — independent of whatever this
checkout's own `.env` happens to contain — so the regression is caught in a clean environment
that never had the original triggering value, not merely in this one. Confirmed failing against
the pre-fix code (real repro: reverted the fix, rebuilt, reran, got the identical `ConfigError`
and exit 1) before confirming it passes against the fix.

**Independent verification, final state, real captured exit codes:** `lint:0` `lint:noleak:0`
`typecheck:0` `test:0` (77 test files, 1573 tests — was 76/1557 before this chunk) `web:build:0`
`playwright --project=desktop:0` (**48 passed, 0 skipped** — 47 plus the new regression test).
Real two-cluster cross-account isolation proof: `npx vitest run --mode integration
test/local-install.int.test.ts` exit 0, 34.7 s, two genuinely separate bundled PostgreSQL data
directories on two different ports, not two schemas in one cluster, not mocked.
`git diff --stat checkpoint/chunk3-complete-4aece2c -- src/services/`: empty. No safety test
touched (`lockdown`, `gatekeeper`, `posting`, `f5-cross-tenant-isolation`, `anchor-whitelabel`,
`architecture-connector-path`, `desktop-shell`, `desktop-packaging`, `local-database.test`,
`e2e-desktop/shell.spec.ts` all confirmed unchanged).

**Kraken read-only security pass, 9/9 clean:** no live path into Google OAuth remains (the two
routes `src/auth/routes.ts` still registers are Gmail/QBO connector callbacks, unrelated to human
login); OS-account mismatch fails closed before any side effect on the file-read path; install.json
credential/port validation unweakened; `src/auth/guard.ts`/`session.ts` untouched, `localSignIn`
produces a session through the identical `createSession` SSO used; session-cookie secret never
touches disk outside the credential store; no OS-identifier leak outside `src/host/**`; the
cross-account isolation tests exercise the real tenant-scoping mechanism and two real clusters,
not a bare column comparison; every new user-facing string is plain language; `src/host/macos.ts`
untouched, still a deliberate out-of-scope stub.

**One finding recorded, not fixed, and deliberately NOT blocking this promise:** in the
database-recovered-identity path (`src/db/local-database.ts`, corrupted/absent `install.json`
but an existing cluster), migrations run against the cluster at `dataDir` **before** the
`OsAccountMismatch` throw, unlike the file-read path which checks before any side effect. This
does not expose cross-account data — nothing is ever returned to the mismatched caller, and
`dataDir` already sits under the current OS account's own `%LOCALAPPDATA%` profile, which a
different Windows account cannot normally reach or have written to in the first place. It is a
narrower ordering guarantee than the file-read path, worth closing in CHUNK_7 (backup/restore)
when that path is next touched, not urgent enough to reopen this chunk for.

Standing environment blockers restated (not dropped): no macOS machine, no signing identities, no
clean VMs.

Locked forwarder: **exactly one** provider-send call site, unchanged. Merge commit: `4fcdd78`,
fix commit `7adf1d0`, both on `feat/local-desktop-p1`, pushed to `origin/feat/local-desktop-p1`.

<promise>CHUNK COMPLETE: CHUNK_4_IDENTITY</promise>
