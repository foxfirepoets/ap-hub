# Ralph State

**Current Iteration:** 1

Current chunk: CHUNK_3_IPC
Current task: 1 of 5
Last completed: **CHUNK_2_DATABASE — complete.** Bundled PostgreSQL 16.10 starts under a real
Electron process, initialises a private cluster, migrates itself and records `install.json`.
Status: CHUNK_2 promise appended to `.ralph/progress.md` on 2026-07-26 (it was claimed here
earlier than it was actually written — the work was real, the record was not; corrected).
CHUNK_3 in progress: interfaces frozen, `agent/ipc-foundation` active.

### CHUNK_3 — in progress (orchestrated, multi-agent)

**Integration branch:** `feat/local-desktop-p1` · **integration commit:** `53c4d9b` (pushed).
**Recovery tag before CHUNK_3:** `checkpoint/chunk3-start-b68984c` (pushed).

Baseline re-verified at `b68984c` before any CHUNK_3 change, matching expectations exactly:
`npm run verify` exit 0 · 70 test files · 602 tests · 37 Playwright (6 of them bundled-PostgreSQL
under a real Electron process) · exactly one provider-send site (`src/gmail/adapter.ts:142`) ·
52 `app/api/**/route.ts` files · `vendor/postgres.lock.json` tree 1631 files / 125898162 bytes
matching the measured `vendor/pgsql` tree.

**Frozen interfaces:** `docs/build/interfaces/` (1587 lines). The load-bearing decision, which is
NOT to be re-opened: the dispatcher reuses the existing exported service wrappers **unmodified**
by synthesizing a `Request` and decoding the `Response`. `src/services/**` is not edited by this
chunk. `runAction` is module-private and has more clones than
`docs/build/route-to-service-map.md:52` records — exporting or unifying them is an authorization
change disguised as a refactor and is forbidden here.

Three findings from the freeze, each verified against the code by the integration lead:

1. `runTaxMappingRead` (`src/services/action/taxMappings.ts:74`) and `runDimensionMappingRead`
   (`src/services/action/dimensionMappings.ts:69`) are **owner-only READ wrappers**, and the route
   map omits both. Porting either with a plain `runRead` widens owner-only data to every role.
2. `ok` is **not** "no code present". `errorResponse('QBO_RETRY', …, 202)`
   (`src/services/action/index.ts:153`) is a genuine `ok: true` carrying a code; the retry screens
   branch on it. Hence the additive `IpcResult.status` field on `desktop/preload.ts`.
3. `runMarkNotificationRead` (`src/services/action/notifications.ts:19`) calls `readContext` with
   **no role**, so `cpa` — otherwise read-only — can perform this one mutation. Faithful to today's
   behaviour and to the route map; **preserved deliberately** in CHUNK_3 rather than silently
   "fixed", because changing it is a behaviour change outside this chunk. Revisit in CHUNK_4.

**Agent worktrees** (see `docs/build/file-ownership.md` for full ownership):

| Branch | Worktree | Task | Status |
|---|---|---|---|
| `agent/ipc-foundation` | `ap-hub-worktrees/ipc-foundation` | dispatcher, envelope, registry, errors, context | **merged** `0ca28f2` |
| `spike/static-export` | `ap-hub-worktrees/export-spike` | throwaway spike: the 3 runtime-id screens | **answered, deliberately NOT merged** — see DEVIATIONS §5a |
| `agent/ipc-read-domains` | `ap-hub-worktrees/ipc-read` | 21 read channels | **merged + activated** `c93e331` |
| `agent/ipc-action-domains` | `ap-hub-worktrees/ipc-action` | 29 mutation channels | **merged + activated** `7a1f4a6` |
| `agent/ipc-renderer` | `ap-hub-worktrees/ipc-renderer` | `app/lib/api.ts` + `session.tsx` → IPC | active |
| `agent/ipc-contract-tests` | `ap-hub-worktrees/ipc-qa` | `test/ipc-contract.test.ts` full replay | active |

**Live at `7a1f4a6`** (tag `checkpoint/chunk3-all-channels`): **all 50 product channels**
registered and serving — 21 read + 29 action. `npm run verify` **exit 0**. 378/378 IPC tests.
Preload bundle 4.8kb (channel-name strings only; no zod, no pg).

Collision resolved at integration: B3 and B4 both registered `aphub:tax-mappings:discover`,
which `buildRegistry` would have thrown `DUPLICATE_CHANNEL` on at startup. Kept B3's — the
deciding fact is the wrapper, and `runDiscoverTaxCodes` goes through `runTaxMappingRead`, the
owner-only READ clone. B3's entry was checked for `queryParams: ['code']` first, because the
service reads `url.searchParams.get('code')` (`src/services/action/taxMappings.ts:238`) and
without it the filter would vanish silently.

**Do not "simplify" these — each is a place a plausible cleanup breaks something:**

- `/api/provider-jobs/:id/retry` has **no** service function; its logic is inline in the route
  file, reproduced verb-for-verb in `desktop/ipc/action/providerJobs.ts`.
- The write-gate's two string fields are permissive (max only, no `min(1)`) **on purpose**.
  `setOwnerWriteGate` (`src/accounting/write-gates.ts:13-19`) only demands non-empty values when
  `enabled` is true, so the DISABLE path sends `''`. A `min(1)` makes turning production
  accounting writes **off** impossible — failing closed in the dangerous direction.
- `cpa` may READ bank statements but not mutate them. The read routes admit three roles,
  `action()` (`src/statements/http.ts:24`) admits two. Unifying them grants CPAs write access.
- There are **9** role-bearing wrappers, not the 5 the route map documents.
- `statements:correct`'s `value` is required-but-**nullable**, not optional.
- `tax-mappings:revalidate` takes an **optional** reason while its three siblings require one.

**Still to do in CHUNK_3:** merge B5 + B6 · delete all **54** route handlers (52 under
`app/api/**` plus the two `app/oauth/*/callback` — DEVIATIONS §5b) · apply the static-export
change (3 new `layout.tsx` + 13 lines across 3 pages — DEVIATIONS §5a) · **build and prove the
`file://` interception under a real Electron process** (currently `[UNVERIFIED in real
Electron]`) · Playwright trace showing zero renderer requests to an AP-Hub origin · B7
read-only security verification · append the CHUNK_3 promise line.

`node_modules` is a directory junction into the main checkout in each worktree. Agents must not
run `npm install`; `package.json` is orchestrator-owned.

**Open question carried into CHUNK_3 (DEVIATIONS.md #4):** three page routes take runtime ids that
`generateStaticParams` cannot enumerate — `statements/[id]`, `transactions/[id]`,
`settings/tax-mapping/[id]`. The spike above is resolving how they work from `file://` without a
product HTTP server and, ideally, without touching a page component. Must be reported explicitly
whichever way it lands.

**Exact next task:** review the `agent/ipc-foundation` handoff (verify `desktop/channels.ts`,
`desktop/main.ts` and `src/**` are byte-identical to `53c4d9b`), apply its two shared-file patches,
merge, then release B3 (read domains) and B4 (action domains) in parallel worktrees.

### CHUNK_2 — closed, with evidence

All acceptance criteria met and evidenced against a REAL server, not mocks:

- Bundle: `scripts/bundle-postgres.mjs` downloads the pinned official archive, verifies its
  SHA-256, trims to `bin`+`lib`+`share` and fingerprints the tree. 120.1 MB / 1631 files.
  `vendor/postgres.lock.json` is tracked; the binaries are not. `--verify-only` reproduces the
  same tree hash.
- Port: probe resolved to **55433** on this machine — upward past a genuinely occupied 55432,
  which is the spec's collision edge case exercised for real rather than simulated. 5432 stayed
  up and untouched throughout.
- Password: generated per install, stored in Windows Credential Manager at
  `APHub/database/superuser` **before** `initdb` runs, and never written to `install.json`.
- Interrupted initialisation is recoverable: a sentinel beside the data directory distinguishes
  our own half-written attempt (clear and retry) from somebody else's data (refuse, non-
  destructively). `initialise()` previously DOCUMENTED that refusal without implementing it.
- Migrations run automatically at launch; a fresh directory reaches head (014 + 015 applied).

Measured on this machine: first launch 13.9 s (initdb-dominated), warm start ~1 s — consistent
with the spike's 12.8 s / 0.7 s.

### Two defects found only because the proof used a real process

1. **`initdb` was handed a password file INSIDE the data directory.** `initdb` refuses a
   non-empty target, so initialisation could never have succeeded. Pre-existing; invisible to
   unit tests because they mocked `execFile`. Fixed: the file is written beside the directory.
2. **`app.getAppPath()` is not the checkout root.** Electron sets it to the directory holding
   the entry script, so the bundled runtime was looked for at `dist-desktop/pgsql/bin`. Fixed:
   the root is derived from the module's own location. Regression test in
   `test/desktop-packaging.test.ts`.

Both were reported identically — "initdb.exe failed", empty stderr — because `run()` discarded
stderr. `PostgresStartFailed` now carries a non-user-facing `detail`, and the shell checks the
executable exists before trying to run it.

### Also fixed: the boot screen could not report failure

`desktop/boot.html` was static markup reading "AP-Hub is starting up". When the database failed
it said that forever, with no explanation and no next action — the dead end the guardrails
forbid. It now subscribes to `aphub:status:engine` and renders running / paused / unstable with
the shell's plain-language sentence. External `boot.js`, because the renderer CSP is
`script-src 'self'`.

## Instructions for ralph

Update this file after every task. Never delete history — append below.
Keep the `**Current Iteration:**` line intact and in that exact format.

Controlling documents:
- `specs/SPEC-local-desktop-shell.md`
- `architecture-decision-packet-ap-hub-local-desktop-2026-07-25.md`
- `IMPLEMENTATION_PLAN.md`
- `.ralph/guardrails.md` — **read the email carve-out before any send-related change**
- `specs/01_CHUNK_1_SHELL.md` … `specs/09_CHUNK_9_PACKAGE.md`

## Standing environment blockers (recorded 2026-07-25)

These are properties of the build environment, not of the code. They cap what any chunk in
this workspace can evidence, and must be restated — never quietly dropped — in any completion
claim that depends on them.

1. **No macOS machine.** macOS host adapters and packaging config are written and typechecked,
   but nothing can be built, signed, notarized or launched on macOS here. Every "on both
   platforms" exit criterion is Windows-only evidenced.
2. **No signing identities.** No Authenticode certificate and no Apple Developer ID /
   notarization credentials. CHUNK_9 can produce an unsigned Windows build only.
3. **No clean VMs.** The clean-machine test plan (packet §18) cannot be executed here.

## History

- 2026-07-25: Plan reset. The `cbv-loc001` "Windows local-only runtime" build was stopped at
  CHUNK_1 task 3 and archived to `archive/pre-local-desktop-20260725/`. It targeted a browser UI at
  `127.0.0.1:3000`, which the local desktop direction removes.
- **Retained from that build:** commits `78c5522` (credential schema), `eb150e0` (Windows Credential
  Manager secret store), `fef9d43` (legacy secret migration). All three carry forward unchanged —
  the desktop architecture still stores provider tokens in the OS credential store.
- **Dropped from that build:** the archived CHUNK_2 loopback HTTP session work. Electron IPC removes
  the listening socket it was designed to defend, so the bootstrap-nonce session is not built.
- Prior forensics: `docs/audits/architecture-map-2026-07-25.md`.
- Migration evidence: `docs/audits/electron-migration-inventory-2026-07-25.md` — 14 of 14 pages are
  `'use client'`, 52 route files total 528 lines, and only 2 renderer files perform network I/O.

### 2026-07-25 — Workspace re-scaffolded (spec-to-ralphprep, merge mode)

Nine chunk specs written. `AGENTS.md`, `PROMPT_plan.md`, `PROMPT_build.md` and `README.ralph.md`
reconciled off the archived 7-chunk Docker build. `.ralph/guardrails.md`, `IMPLEMENTATION_PLAN.md`
and this file's prior history preserved verbatim. `PROMPT_build.md` had carried a blanket
"never … send email" instruction — replaced with the locked-forwarder carve-out, which requires
**exactly one** send site and treats zero as a defect.

### 2026-07-25 — Iteration 1 — CHUNK_1_SHELL complete

`npm run verify` exit 0. 65 test files, 31 Playwright. No existing test modified. Locked
forwarder intact (exactly one send site). Static export deferred to CHUNK_3 — see DEVIATIONS.md
#4; `next build --output export` cannot run while `app/api/**` exists.

### Pre-reset history (cbv-loc001, archived)

- Iteration 1: committed CBV-LOC001; full `npm run verify` passed.
- Iteration 2: closed the camelCase/concatenated secret-key constraint bypass; verify passed.
- Iteration 3: replaced the secret-key denylist with strict metadata and transport-mode schemas.
- Iteration 4: closed allowed-field value channels, removed free-form refresh messages.
- Iteration 5: closed whitespace/case value-validation bypasses; amended as `78c5522`.
