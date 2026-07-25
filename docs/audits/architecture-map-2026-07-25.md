# Architecture Cartographer Report — AP-Hub

**Audited:** 2026-07-25 · **Mode:** FULL AUDIT · **Repo:** `C:\Users\Administrator\Desktop\ap-hub` @ `main` `fef9d43`
**Focus:** what survives a pivot to a local-first desktop application with zero-technical-knowledge onboarding.

---

## Executive Summary

AP-Hub is an accounts-payable engine that reads accounting email from Gmail, extracts invoices and
bank statements with a vision model, and produces reviewable QuickBooks transactions. The single
most important finding: **the architecture you just described is already written down in this
repo** — `specs/reference/ARCHITECTURE-ap-hub-platform.md` §8, §11 and §12 specify permission-gated
filesystem discovery, a bundled invisible PostgreSQL, and a desktop shell, as Phases 1B/1C/2.
Codex has been building Phase 1A foundations. The top recommendation is therefore not a rewrite:
**re-sequence to the Phase 2 target, retire the hosted broker and the browser-based UI shell, and
build the two things that genuinely do not exist yet — filesystem discovery and a desktop app.**

---

## Project Map

### Project Type
Single-repo Node 20 / TypeScript ESM application with two deployable units: the AP-Hub app
(engine + Next.js UI) and a separate hosted key broker (`broker/`). Not a formal monorepo — no
workspaces field in `package.json`.

### Main Applications
| App/Service | Path | Framework | Runtime | Purpose |
|---|---|---|---|---|
| AP-Hub engine | `src/` | none (plain Node) | Node 20 ESM | HTTP server + pg-boss workers; the product |
| AP-Hub web UI | `app/` | Next.js 14 App Router | Node / browser | 14 pages, 52 API routes |
| Key broker | `broker/` | plain Node | Node 20, hosted on Render | Holds operator Anthropic + SwarmSync keys; per-install bearer auth; pilot telemetry |

### Entry Points
| Entry | File Path | Notes |
|---|---|---|
| Engine boot | `src/index.ts` | HTTP (`/health`, OAuth callbacks) + `registerPipelineJobs` |
| Operator CLI | `src/cli.ts` | `npm run cli -- <command>`; commander |
| Web UI | `app/layout.tsx`, `next.config.mjs` | `next start -p 3000 -H 127.0.0.1` |
| Broker | `broker/src/index.ts` | `npm start` in `broker/` |
| Migrations | `src/db/migrate.ts` | Custom runner over `migrations/*.sql` |

### Important Config
| File | Path | What It Controls |
|---|---|---|
| Typed config | `src/config.ts` | 59 env vars, fail-closed validation |
| Env contract | `.env.example` | 59 declared variables |
| Docker Postgres | `compose.yaml` | Dev-only Postgres 16.9 on port 5432 |
| Broker deploy | `broker/render.yaml` | Render web service + managed Postgres |
| No-leak lint | `scripts/lint-noleak.mjs` | Provider/OS token ban in core |

### Deployment Surface
| Platform | Config File | Services Deployed | Notes |
|---|---|---|---|
| Render | `broker/render.yaml` | `aphub-broker` web + free Postgres | **The only hosted surface in the repo** |
| Windows (manual) | `deploy/install.ps1`, `install-core.ps1`, `install-gui.ps1`, `Install-ap-hub.cmd` | Local install | PowerShell, non-admin |
| Windows (pilot) | `pilot/install-pilot.ps1`, `aphub-watchdog.xml`, `start-aphub.ps1` | Task Scheduler watchdog | Pilot harness |
| App itself | — | none | **No hosting config for AP-Hub exists — correct for the new direction** |

### Test Surface
| Type | Directory | File Count | Framework |
|---|---|---|---|
| Unit + DB-backed | `test/` | 64 (`*.test.ts`) + 1 `.int.test.ts` | Vitest |
| Broker | `broker/test/` | 10 | Vitest |
| UI contract | `e2e/app.spec.ts` | 24 tests | Playwright (all `/api/**` stubbed) |

### Docs Surface
| Doc | Path | Apparent Status |
|---|---|---|
| Reference architecture | `specs/reference/ARCHITECTURE-ap-hub-platform.md` | **Current and authoritative — the key asset** |
| Provider research | `specs/reference/provider-research-2026-07-17.md` | Current; QBD/Xero/Sage mechanism evidence |
| Agent guide | `CLAUDE.md` | **Stale** — guarantees #1/#3 contradict code |
| Prior TFL audit | `docs/TRUTH-BEFORE-LAUNCH-2026-07-24.md` | Current, verdict RED |
| Deviations | `DEVIATIONS.md` | Current, 3 disclosed departures |
| 7 feature specs | `specs/SPEC-*.md` | Mixed — 5 built, 2 superseded |

---

## System Understanding

**Product purpose.** Turn accounting email into reviewed, correctly coded, non-duplicated
accounting transactions without the user trusting invisible automation
(`specs/SPEC-multi-edition-accounting-intake.md:82`).

**Users.** SMB owners and their bookkeepers — matching the two personas in the new direction.
RBAC already models exactly three roles: owner (approve/post), bookkeeper (prepare, no post),
CPA (read-only) — `e2e/app.spec.ts:155,165,250`.

**Core backend flow.** `poll → gatekeep → classify → extract → map → propose → post` plus a daily
`audit_anchor` (`src/pipeline/register.ts:9-89`). Every stage is an injectable interface, which is
why the engine survives a UI replacement intact.

**Critical systems**
| System | Path | Breaks = |
|---|---|---|
| Pipeline orchestration | `src/pipeline/` | Nothing processes |
| Extraction | `src/extract/` + `src/llm/` | No document understanding |
| Connectors | `src/connectors/`, `src/qbo/`, `src/qbdesktop/` | No accounting writes |
| Postgres + pg-boss | `src/db/`, `migrations/` (13) | Total loss |
| Credential store | `src/host/windows.ts` | No provider access |

**Stubbed / demo-only**
| System | Path | Risk |
|---|---|---|
| Xero, Sage Intacct connectors | `src/connectors/stubs.ts` | **None — throw `NotImplementedInPhase`, honestly labelled.** Required by the new direction; must be built. |
| All 24 Playwright tests | `e2e/app.spec.ts:97-226` | Medium — every `/api/**` call is `page.route`-stubbed; proves UI wiring only |
| SwarmSync proof layer | `src/swarmsync/` | Low — `SWARMSYNC_ENABLED` default true but degrades closed |

---

## Architecture Map

### Frontend Surface
| Area | File Path | Purpose | Status |
|---|---|---|---|
| Today / triage | `app/(app)/today/page.tsx` | Main queue | Active |
| Exceptions (+dimensions, tax) | `app/(app)/exceptions/**` | Review queues | Active |
| Transactions (+detail) | `app/(app)/transactions/**` | Posting history | Active |
| Statements (+detail) | `app/(app)/statements/**` | Bank statement review | Active |
| Settings (+tax mapping) | `app/(app)/settings/**` | Config surface | Active |
| Audit | `app/(app)/audit/page.tsx` | Audit trail | Active |
| Onboarding | `app/(app)/onboarding/page.tsx` | Setup flow | Active — **precursor to the new wizard** |
| Login | `app/login/page.tsx` | Google SSO entry | **Conflicts with new direction** |
| Shared components | `app/components/` (7), `app/lib/` (7) | Stepper, welcome, evidence panel, permissions | Active — reusable in a desktop renderer |

### API Surface
52 route files under `app/api/**/route.ts`, plus OAuth callbacks on the engine process
(`app/oauth/gmail/callback`, `app/oauth/qbo/callback`). Auth is a signed server session
(`src/auth/session.ts`) with tenant + RBAC checks in `src/services/`.

### Database
13 migrations (`migrations/001…013`), custom idempotent runner (`src/db/migrate.ts`).
Canonical AP model in `src/canonical/`; repositories in `src/accounting/repositories.ts`.
Money is `NUMERIC`, read as string. No orphaned models found.

### External Integrations
| Integration | Package | Env Var | Import Location | Risk |
|---|---|---|---|---|
| Gmail | `googleapis` | `GOOGLE_CLIENT_ID/SECRET` | `src/gmail/adapter.ts:18`, `src/auth/gmail-oauth.ts:41` | Low |
| Anthropic | `@anthropic-ai/sdk` | `ANTHROPIC_API_KEY` | `src/extract/model.ts:234` | Low |
| Any OpenAI-compatible / local LLM | fetch | `LLM_BACKEND`, `LLM_BASE_URL` | `src/llm/provider.ts:67-113`, `src/llm/detect.ts` | Low |
| PDF rasterization | `mupdf` | — | `src/extract/pdf.ts:12` | Low |
| QuickBooks Online | fetch | `QBO_*` | `src/qbo/client.ts`, `src/qbo/write.ts` | Low |
| QuickBooks Desktop | SOAP/qbXML | `QB_DESKTOP_*` | `src/qbdesktop/soap.ts`, `qbxml.ts` | Low |
| SwarmSync proof | fetch | `SWARMSYNC_*` | `src/swarmsync/` | Medium — external dependency for a consumer product |
| Key broker | fetch | `BROKER_BASE_URL` | `src/services.ts`, `src/extract/model.ts` | **High — hosted URL** |
| Telegram alerts | fetch | `TELEGRAM_*` | `src/gatekeeper/telegram.ts:21` | Medium |

### Jobs / Scripts
| Script/Job | File Path | Trigger | In CI? | Notes |
|---|---|---|---|---|
| 8 pipeline jobs | `src/pipeline/register.ts` | pg-boss | n/a | Core |
| No-leak lint | `scripts/lint-noleak.mjs` | `npm run verify` | Yes | Scoped, see DEVIATIONS #3 |
| Windows install (4) | `deploy/*.ps1`, `.cmd` | Manual | No | Reusable by the new installer |
| Pilot harness (7) | `pilot/*.ps1`, `aphub-watchdog.xml` | Manual | No | Watchdog reusable; pilot framing is not |

---

## Integration Forensics

| Integration | Installed? | Env Vars? | Imported? | Live Usage? | Verdict | Recommendation |
|---|---|---|---|---|---|---|
| googleapis | Yes | Yes | Yes (dynamic) | Yes | **Keep** | Core ingest; unchanged by the pivot |
| @anthropic-ai/sdk | Yes | Yes | Yes (dynamic) | Yes | **Keep** | One backend among several |
| LLM detect/provider | n/a | Yes | Yes | Yes | **Keep** | Already auto-detects local runtimes — exactly the new direction |
| mupdf | Yes | n/a | Yes (dynamic) | Yes | **Keep** | This is the "OCR/document-processing component" |
| pg / pg-boss | Yes | Yes | Yes (15 / 5 files) | Yes | **Keep** | Must become bundled + invisible |
| next / react | Yes | n/a | Yes (19 files) | Yes | **Refactor** | Keep components, drop the browser-served shell |
| zod, pino, commander, dotenv | Yes | n/a | Yes | Yes | **Keep** | No unused dependency found in the entire manifest |
| QBO connector | n/a | Yes | Yes | Yes | **Keep** | Reference impl for the connector contract |
| QBD connector | n/a | Yes | Yes | Yes | **Keep** | ~1,800 lines; the hardest integration, already built |
| Xero / Sage Intacct | n/a | No | Yes | **No — throws** | **Build** | Required by the new direction; contract seam already exists |
| Key broker | Yes (`broker/`) | Yes | Yes | Yes when configured | **Isolate → Archive** | See finding below |
| SwarmSync | n/a | Yes | Yes | Yes | **Verify** | Decision needed: does a consumer product depend on an external proof service? |
| Telegram | n/a | Yes | Yes | Behind `GATEKEEPER_ENABLED` (default false) | **Verify** | Operator-era alerting; desktop notifications replace it |

### Key broker — Isolate → Archive
**Evidence:**
- `broker/render.yaml:12-20` — `type: web`, hosted on Render with a managed Postgres.
- `broker/package.json` — *"holds Ben's Anthropic + SwarmSync keys, per-install bearer-token auth, pilot telemetry."*
- `src/config.ts:80-81` — `BROKER_BASE_URL` (optional), `BROKER_INSTALL_TOKEN`.
- `src/config.ts:166-171` — must be `https://` outside tests.
- `src/extract/model.ts`, `src/services.ts`, `src/telemetry.ts` — broker-routed model and proof calls.

**Why this verdict:** the new direction states *"No hosted AP-Hub website. No public AP-Hub URL."*
A hosted key broker that every install calls at runtime for model and proof traffic **is** a public
AP-Hub URL, and it also transmits pilot telemetry off the user's machine. It exists to avoid putting
the operator's keys on tester machines — a pilot-era problem that disappears when each customer uses
their own key or a local model runtime.

**Recommended action:** archive `broker/` wholesale. The removal is low-risk because
`BROKER_BASE_URL` is already optional and `src/llm/detect.ts` + `src/llm/provider.ts` already
support local runtimes and user-supplied keys as first-class paths. Delete `BROKER_BASE_URL` and
`BROKER_INSTALL_TOKEN` from `src/config.ts` and `.env.example`, and strip the broker branches in
`src/extract/model.ts`, `src/services.ts`, `src/telemetry.ts`.

### Next.js web shell — Refactor
**Evidence:**
- `package.json` — `"web:start": "next start -p 3000 -H 127.0.0.1"`.
- `app/login/page.tsx` — Google SSO as the product entry point.
- `playwright.config.ts:31` — `baseURL: http://localhost:${PORT}`.

**Why this verdict:** a product the user reaches by opening Chrome at an address violates
*"No requirement to open Chrome"* and *"No address the user must bookmark or type."* But the 14
pages, 7 components and 7 lib modules are ordinary React and are not the problem — the delivery
shell is.

**Recommended action:** keep the React tree, move it into a desktop renderer, replace the
browser-session login with process-local trust. Do not rewrite the screens.

---

## Deadweight Findings

| Finding | File Path(s) | Evidence | Why It Matters | Recommendation | Priority |
|---|---|---|---|---|---|
| 4 completed Ralph workspaces | `ralph-guided-installer/`, `ralph-northstar-ux/`, `ralph-onboarding-connect/`, `ralph-pilot-foundation/` | 69 tracked files; all four `.ralph/state.md` read `BUILD COMPLETE` | Historical build logs an agent can mistake for live plans | **Archive** | P2 |
| Docker Postgres | `compose.yaml` | Postgres 16.9 on host port 5432 | New direction bans Docker; §12 mandates a bundled private PG on a probed port from 55432 | **Replace** | P1 |
| Hosted key broker | `broker/` (22 tracked files + `render.yaml`) | See forensics above | Only hosted surface; contradicts "no public AP-Hub URL" | **Archive** | P1 |
| Pilot harness framing | `pilot/` (7 scripts) | `New-PilotCredentialBundle.ps1` distributes broker tokens | Pilot-era; watchdog + validate-clean-install are reusable | **Consolidate** into the new installer | P2 |
| Superseded specs | `specs/SPEC-pilot-harness-key-broker.md`, `SPEC-windows-local-only-runtime.md` | Both assume broker and/or browser UI | Codex is actively building the second one | **Archive** | **P0** |
| 59 user-visible env vars | `.env.example` | `grep -c '^[A-Z]*=' .env.example` → 59 | New direction: *"No … environment variables exposed to the user"* | **Refactor** to installer-managed config | P1 |
| Stale agent guide | `CLAUDE.md` | Guarantee #3 claims config refuses `production`; `src/config.ts:52` accepts it behind a gate; test `no_prod_write` does not exist | Every agent loads this as authoritative | **Rewrite** | P1 |
| Untracked build artifacts | `dist/`, `test-results/`, `.next/` | `git ls-files` returns nothing for all three | Already gitignored | No action | P3 |

**Zero unused dependencies.** Every package in `package.json` resolves to a live import; the four
that returned no static match (`googleapis`, `@anthropic-ai/sdk`, `mupdf`, `next`) are dynamic
imports or framework-convention usage, confirmed individually.

---

## Misfit Architecture

| Area | File Path(s) | Current Implementation | Why Misfit | Better Pattern | Priority |
|---|---|---|---|---|---|
| Product delivery | `app/`, `package.json` `web:start` | Next.js served at `127.0.0.1:3000`, opened in a browser | *UI shell wrong for the stated product* — a consumer desktop product cannot require a browser tab and a memorized address | Desktop shell (Electron/Tauri) embedding the existing React tree; engine as a child process | **P0** |
| Product entry auth | `app/login/page.tsx`, `src/auth/google-sso.ts` | Google SSO gates the local product | Hosted-SaaS auth pattern on a single-user local app; the user's Google account is an *integration*, not a door key | OS-user-bound local session (already specified in `specs/02_CHUNK_2_AUTH.md`) | P1 |
| Runtime key custody | `broker/`, `src/config.ts:80` | Hosted broker holds keys, ships telemetry | *Hosted dependency in a local-first product* | Local credential storage (already built: `src/host/windows.ts:176`) + user's own key or local model | P1 |
| Database provisioning | `compose.yaml` | Docker Compose on port 5432 | *Developer tool in a consumer install path*; also collides with any existing Postgres | Bundled private PG as a supervised child on a probed port (`specs/reference/…:§12`) | P1 |
| Setup questioning | `app/(app)/onboarding/page.tsx`, `src/services/action/onboarding.ts` | Asks the user to supply connection details | *Asks before discovering* — inverts the new "Discover → Infer → Ask" rule | Discovery-first wizard; ask only what cannot be found or inferred | **P0** |
| Error surfacing | `app/lib/onboardingErrors.ts:34` | Falls back to `Details: ${fallbackMessage}` — raw provider text | Leaks technical errors the new direction bans | Exhaustive plain-language mapping with a safe generic default | P1 |
| E2E coverage | `e2e/app.spec.ts:97-226` | All 24 tests stub every `/api/**` | *Tests proving mocked behavior* — green E2E cannot detect a broken integration | Keep as UI contract; add real-integration tests against disposable accounts | P1 |

---

## Risk Register

| Risk | Category | Evidence | Impact | Recommended Fix | Priority |
|---|---|---|---|---|---|
| Active build aimed at the superseded target | Production | `.ralph/state.md` `Current chunk: CHUNK_1_SECRETS`; `specs/SPEC-windows-local-only-runtime.md:11` keeps Next.js at `127.0.0.1:3000` | Agent hours spent on a UI shell the new direction removes | Pause the loop; re-spec before resuming | **P0** |
| Spec mandates deleting the send-lockdown | Security | `specs/SPEC-windows-local-only-runtime.md:161,429,502` ban any `messages.send`; `src/gmail/adapter.ts:142` and `app/api/replies/[id]/send/route.ts` implement the locked forwarder | Loop deletes a core guarantee or stalls at CHUNK_3 | Carve out the locked forwarder, or remove it deliberately | **P0** |
| No filesystem discovery exists | Production | Only `node:fs` uses in `src/` are `src/db/migrate.ts:1` and `mkdirSync` in `src/host/{windows,macos}.ts:9`. Zero `.qbw`, zero `readdir` outside migrations | Screens 2–4 of the new wizard have no foundation at all | Build against `specs/reference/…:§8` | **P0** |
| No QuickBooks installation detection | Production | No registry probe anywhere in `src/` | Cannot auto-detect edition or company files | Build Windows registry + file probes | **P0** |
| Broker transmits telemetry off-machine | Compliance | `broker/package.json` description; `src/telemetry.ts` | Consumer privacy expectation breach | Archive broker; keep telemetry local | P1 |
| Nothing pushed to origin | Deployment | `git status -sb` → `ahead 3`; 19 uncommitted files incl. all new specs and `archive/` | Total loss of CHUNK_1 work + specs if the machine fails | Commit and push | P1 |
| CLAUDE.md guarantees contradict code | Maintainability | Guarantee #1 cites deleted chunk numbering; #3 contradicts `src/config.ts:52`, `src/qbo/write.ts:45`; `no_prod_write` test absent | Next agent trusts an unenforced guarantee | Rewrite CLAUDE.md | P1 |
| Progress trackers disagree | Maintainability | `.ralph/state.md` "task 1 of 4"; plan has 2 `[x]`; commit `fef9d43` implements task 3's exact files; no `progress.md` entry | Duplicate or skipped work | Reconcile on re-spec | P1 |
| Green E2E cannot detect integration failure | Maintainability | `e2e/app.spec.ts` — all API stubbed | False confidence | Add live-integration tier | P1 |
| SwarmSync is an external runtime dependency | Integration | `src/config.ts:71` default true | Consumer product depending on operator infrastructure | Decide: local-only proof, or off by default | P1 |

---

## Target Architecture

**Keep (build on, do not touch)**
- Pipeline engine `src/pipeline/` — 8 injectable stages, provider-neutral.
- Extraction `src/extract/` + `src/llm/` — `src/llm/detect.ts` already auto-detects Ollama/LM Studio/
  OpenAI-compatible endpoints and degrades to a user key. This is precisely the
  "user knows nothing" model story and needs no redesign.
- Connector contract `src/connectors/types.ts` + QBO and QBD implementations (~2,100 lines).
- Canonical AP model `src/canonical/`, `src/accounting/`.
- Postgres schema + 13 migrations + `src/db/migrate.ts`.
- Windows Credential Manager store `src/host/windows.ts:176` — CHUNK_1 work, directly reusable.
- Bank statements `src/statements/` (866 lines) and Gmail drafts `src/gmail/drafts.ts`.
- RBAC (owner / bookkeeper / CPA) — already matches the two-persona requirement.
- React screens `app/(app)/**`, `app/components/`, `app/lib/` — as renderer content.
- Watchdog/install PowerShell in `deploy/` and `pilot/` — as installer internals.

**Archive (retire from the working tree)**
- `broker/` + `broker/render.yaml` — verified optional at `src/config.ts:80`.
- `ralph-guided-installer/`, `ralph-northstar-ux/`, `ralph-onboarding-connect/`, `ralph-pilot-foundation/` — all `BUILD COMPLETE`.
- `compose.yaml` — replaced by bundled PG.
- `specs/SPEC-pilot-harness-key-broker.md`, `specs/SPEC-windows-local-only-runtime.md`, `specs/01–07_CHUNK_*.md`.
- `specs/SPEC-northstar-ux-v1.md`, `SPEC-guided-onboarding-installer.md`, `SPEC-onboarding-real-connect-redesign.md`, `SPEC-reviewer-dashboard.md`, `SPEC-multi-edition-accounting-intake.md` — built; superseded as forward plans.

**Do not archive**
- `specs/reference/ARCHITECTURE-ap-hub-platform.md` — the grounding doc for the new spec.
- `specs/reference/provider-research-2026-07-17.md` — QBD/Xero/Sage mechanism evidence.
- `DEVIATIONS.md`, `docs/TRUTH-BEFORE-LAUNCH-2026-07-24.md`.

**Replace**
- Browser-served UI → desktop shell embedding the existing React tree.
- Google SSO product login → OS-user-bound local session.
- Docker Postgres → bundled private PostgreSQL, supervised child, probed port.
- Hosted broker key custody → local Credential Manager (already built).

**Build (does not exist — verified absent)**
1. Permission-gated filesystem discovery (`specs/reference/…:§8` is the design).
2. QuickBooks Desktop installation + company-file detection.
3. Desktop application shell + one-click bundled installer.
4. Xero and Sage Intacct connectors against the existing contract.
5. Inference layer — vendors, chart of accounts, coding patterns from prior behavior.
6. Plain-language error translation with no raw-message fallback.

**Source-of-truth decisions needed**
| Decision | Options | Evidence |
|---|---|---|
| Desktop shell | Electron (React reuse, large bundle) · Tauri (small, Rust toolchain) · tray + local browser (least work, but violates "no Chrome") | `specs/reference/…:§11` leaves this open for Phase 2 |
| SwarmSync in a consumer product | Keep on · off by default · remove | `src/config.ts:71` default true |
| Gatekeeper forwarder | Keep with carve-out · remove | `src/pipeline/gatekeep.ts:21`, `GATEKEEPER_ENABLED` default false |
| macOS | Windows-only v1 · both | §2 names macOS equivalents but QBD is Windows-only (§10) |

---

## Coder Task Plan

#### Task 1: Freeze the superseded build (P0)
**Goal:** no agent continues building toward the browser-UI target.
**Files:** `.ralph/state.md`, `IMPLEMENTATION_PLAN.md`, `specs/SPEC-windows-local-only-runtime.md`, `specs/01–07_CHUNK_*.md`
**Work:** 1. Record that `cbv-loc001` is paused at CHUNK_1 task 3. 2. Move the spec + 7 chunk files to `archive/`. 3. Note in `.ralph/state.md` which commits are retained.
**Validation:** `git status --short && grep -c CHUNK specs/*.md`
**Acceptance:** - [ ] No active plan references the browser UI as the product surface.
**Risk if skipped:** agent hours spent on a deleted shell.

#### Task 2: Resolve the send-lockdown collision (P0)
**Goal:** the spec's no-send rule and the locked forwarder cannot both be true.
**Files:** `src/gmail/adapter.ts:142`, `app/api/replies/[id]/send/route.ts`, `src/pipeline/gatekeep.ts:21`, `.ralph/guardrails.md`
**Work:** 1. Decide keep-with-carve-out or remove. 2. Encode in the new spec as a named exception or a deletion task.
**Validation:** `npm run verify`
**Acceptance:** - [ ] A repo scan for `messages.send` returns either zero hits or exactly one documented allowed site.
**Risk if skipped:** CHUNK_3 deletes send-lockdown or the acceptance scan fails.

#### Task 3: Commit and push everything (P0)
**Goal:** the machine is not the only copy.
**Files:** all 19 uncommitted paths incl. `archive/`
**Work:** 1. `git add -A` 2. commit 3. `git push origin main`
**Validation:** `git status -sb` shows no ahead count and a clean tree
**Acceptance:** - [ ] `origin/main` == local `HEAD`.
**Risk if skipped:** total loss of CHUNK_1 and every new spec.

#### Task 4: Rewrite CLAUDE.md against the code (P1)
**Goal:** the agent guide states only enforced guarantees.
**Files:** `CLAUDE.md`
**Work:** 1. Correct guarantee #3 to the owner-gated production model (`src/config.ts:148-161`). 2. Remove the `no_prod_write` reference or restore the test. 3. Replace deleted chunk numbering.
**Validation:** for each named guarantee test, `grep -rl "<name>" test/`
**Acceptance:** - [ ] Every guarantee cites a test that exists.
**Risk if skipped:** agents trust an unenforced guarantee.

#### Task 5: Archive the broker and retire its config (P1)
**Files:** `broker/`, `src/config.ts:77-81,166-171`, `.env.example:74-75`, `src/extract/model.ts`, `src/services.ts`, `src/telemetry.ts`
**Work:** 1. Move `broker/` to `archive/`. 2. Remove both env vars. 3. Delete broker branches, keeping direct/local provider paths.
**Validation:** `npm run verify && grep -rn "BROKER_" src/ | wc -l` → 0
**Acceptance:** - [ ] No hosted URL is reachable from any runtime path.
**Risk if skipped:** the product keeps a public dependency it is specified not to have.

#### Task 6: Archive completed Ralph workspaces and built specs (P2)
**Files:** the 4 `ralph-*/` dirs, 5 built `specs/SPEC-*.md`
**Work:** move to `archive/`, leaving `specs/reference/` in place.
**Validation:** `ls specs/` shows only `reference/` and the new spec
**Acceptance:** - [ ] `specs/` contains exactly one forward-looking spec.

---

## Validation Checklist
- [x] Structure mapped from `git ls-files`, not assumed
- [x] Entry points, 52 API routes, 14 UI pages mapped with paths
- [x] DB models mapped (13 migrations, custom runner)
- [x] Env vars traced (59 declared; broker pair traced to `src/config.ts:80`)
- [x] Every dependency checked against imports, including the 4 dynamic-import false positives
- [x] Integrations checked installed / imported / live-wired
- [x] Scripts, jobs, deploy configs, tests reviewed
- [x] Docs claims compared to code (CLAUDE.md contradiction found)
- [x] Dead/misfit findings carry evidence + named pattern
- [x] Risk register cites file:line
- [x] Task plan has file paths; all P0/P1 have validation commands
- [x] `npm run verify` reproduced independently → exit 0

## Open Questions / Decisions Needed
1. **Desktop shell technology** — Electron reuses the React tree as-is; Tauri is smaller but adds a Rust toolchain. Resolved by the owner.
2. **SwarmSync in a consumer product** — resolved by deciding whether proof-gating is a product feature or operator infrastructure.
3. **macOS in v1** — QBD is Windows-only (`specs/reference/…:§10`), so macOS ships without desktop QuickBooks. Resolved by the owner.
4. **Gatekeeper forwarder** — keep with a documented carve-out, or delete. Resolved by Task 2.
