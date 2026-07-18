# SPEC: Phase 1A — Pilot Foundation (Key Broker + Provider-Neutral Core + Windows Harness)

> **This spec builds Phase 1A only** — the buildable foundation of a cross-platform (Windows + macOS), provider-neutral (QBO · QBD · Xero · Sage Intacct) AP automation platform. The durable platform architecture, provider capability matrices, QuickBooks Desktop bridge contract, canonical AP model, filesystem-discovery threat model, and the full phase plan (1A → 1B → 1C → 2) live in the grounding doc `specs/reference/ARCHITECTURE-ap-hub-platform.md`. Phase 1A lays the cross-platform + provider-neutral seams and proves reliability with one OS (Windows) and one provider (QBO sandbox); it does **not** build macOS execution, the other three providers, folder scanning, Electron, code signing, auto-update, or any production accounting write. Those are later phases, each gated on this pilot's evidence.

## Metadata
- Version: 2.0 | Date: 2026-07-17 | Tier: **FULL** | Greenfield/Brownfield: **Both** (new greenfield broker service + brownfield interface-extraction/rewiring of `ap-hub`)
- Status: **Ready for Build**
- Success measure: 30 days after ship, the pilot has produced three real numbers from 3–5 tester machines — (a) % of business hours the supervised processes were alive, (b) watchdog recovery rate (recovered restarts ÷ total process deaths), (c) count of local-Postgres corruption incidents — with zero pilot installs ever holding `ANTHROPIC_API_KEY` or `SWARMSYNC_API_KEY` on disk, AND the provider-neutral seam proven by the existing QBO connector passing the new `AccountingConnector` contract suite unchanged in behavior.
- Architecture grounding: **`specs/reference/ARCHITECTURE-ap-hub-platform.md`** (durable platform architecture, 2026-07-17) + `docs/audits/architecture-map-2026-07-17.md` (integration forensics) + `specs/reference/provider-research-2026-07-17.md` (sourced provider facts). No governor packet exists for this feature; the repo's one packet (`architecture-decision-packet-ap-hub-northstar-ux-2026-07-14.md`, verdict **NEEDS_ARCHITECTURE_DECISION**) governs the North Star UX layer, a different system, and is not consumed here.
- Upstream input: `Ultimate Brainstorm Output/ap-hub-windows-installer-architecture__20260717_055402` (6-agent installer stress test) + owner platform direction (2026-07-17: cross-platform + 4 providers + staged pilot).
- Open questions: 0 (broker host confirmed Render by owner 2026-07-17; portability preserved per `ARCHITECTURE-ap-hub-platform.md#7`)

## Tech Stack

**Broker service (new):** Node 20 · TypeScript (ESM, `moduleResolution: Bundler`) · `node:http` (no framework — mirrors `src/http.ts`) · PostgreSQL (managed, provided by host) · Zod for config/validation · Pino for logging · Vitest for tests. Hosted on **Render** (free web service + free Postgres). Deployed via `render.yaml` blueprint.

**ap-hub changes (existing):** Node 20 · TypeScript (ESM) · PostgreSQL · pg-boss · Vitest · Next.js 14 (unchanged). No new runtime dependency added to `package.json`. New internal seams (interfaces + reference impls, no new deps): `src/connectors/` (`AccountingConnector`), `src/host/` (`HostAdapter`), `src/broker/` (`BrokerClient`), `src/canonical/` (canonical AP model types).

**Pilot harness (new):** cross-platform Node supervisor behind a `HostAdapter` seam. Windows reference host: PowerShell 5.1+ (Windows Server 2025 / Windows 10+) · Task Scheduler XML · portable PostgreSQL 16 binaries (EnterpriseDB zip, no installer, no admin rights) · portable Node 20 runtime. macOS host adapter: compiled/type-checked in Phase 1A (LaunchAgent + Keychain), **exercised in Phase 1B**.

Commands — build: `npm run build` · test: `npm test` · lint: `npm run lint` · typecheck: `npm run typecheck` · web build: `npm run web:build` · broker test: `npm --prefix broker test`. New: `npm run lint:noleak` (provider/OS-leakage lint, see §10).

## Architecture Grounding Summary

**Full platform architecture is grounded in `specs/reference/ARCHITECTURE-ap-hub-platform.md`** (three seams — `AccountingConnector`, `HostAdapter`, `BrokerClient`; canonical AP model; provider matrices; QBD bridge; phase gates). That doc's §0 proves this is **interface extraction around tested logic**, not a rewrite: the core is already OS-neutral (zero `process.platform`/`win32`/`C:\` in `src/`), `createEntity(type,payload,requestId)` is already provider-generic, read-back + idempotency + dimensional mappings already exist, and JSONB lets the canonical model widen with no migration.

**Systems touched (Phase 1A):**
- `src/config.ts` — `ANTHROPIC_API_KEY`/`SWARMSYNC_API_KEY` become optional; add `BROKER_BASE_URL` (https-validated) + `BROKER_INSTALL_TOKEN`.
- `src/services.ts:11` (`swarmsync()`) — constructs `SwarmSyncClient` pointed at the broker in broker mode.
- `src/extract/model.ts:71` — sibling `getBrokerExtractor` implementing the existing `Extractor` interface.
- `src/pipeline/extract.ts:214` — selects extractor by config.
- **`src/connectors/` (new)** — `AccountingConnector` interface + `CapabilityMatrix` + `Unsupported`; **QBO reference adapter wrapping the existing `src/qbo/` code** (thin delegation, zero change to `write.ts` logic); connector contract-test suite.
- **`src/canonical/` (new)** — canonical AP model types (§ARCHITECTURE-5), mapping helpers to `proposals.proposed_txn` JSONB + `mappings`.
- **`src/host/` (new)** — `HostAdapter` + `SecretStore` interfaces; Windows impl; macOS impl (compiled, exercised Phase 1B).
- **`src/broker/` (new)** — host-neutral `BrokerClient` used by the extractor + swarmsync composition.
- `src/auth/tokens.ts:10` — `Provider` enum widened `'gmail'|'qbo'` → adds `'xero'|'sage_intacct'|'qbd'` (enum only; no new provider logic in 1A).
- `migrations/00X` (new, additive) — generalize `postings.qbo_type`→`entity_type`, `qbo_id`→`external_id`, `sync_token`→`revision` **behind a back-compat VIEW**; add `connections` table (non-OAuth connection metadata). No column dropped; existing queries keep working via the view.
- `.env.example` — port drift corrected + broker vars.
- `broker/**`, `harness/**` — new, self-contained.

**Systems whose LOGIC is explicitly NOT changed:** `src/qbo/write.ts` (wrapped, not edited — guarantee 1/3 bearing), `src/gatekeeper/forwarder.ts`, `src/gatekeeper/telegram.ts`, `src/pipeline/register.ts`, `src/pipeline/posting.ts`, `src/pipeline/gatekeep.ts`, `src/gmail/**`, `migrations/001–005` (only additive new migrations), `app/**`, `src/swarmsync/client.ts` (construction changes; code does not). The connector extraction **adds an interface above** `src/qbo/` — it does not modify the write path that the six-guarantee tests cover.

**Source of truth:**
| Entity | Authority | Note |
|---|---|---|
| Pipeline/business data (proposals, exceptions, proofs) | ap-hub local Postgres | Unchanged. The broker stores none of it. |
| `ANTHROPIC_API_KEY`, `SWARMSYNC_API_KEY` | **Broker host env only** | Sole claimant after this spec. Removing them from the desktop is the point. |
| Install identity + spend budget | Broker Postgres (`installs`) | Sole claimant. |
| Pilot telemetry (liveness, restarts, PG health) | Broker Postgres (`heartbeats`) | Sole claimant. |

No entity has two claimants. **Zero source-of-truth conflicts.**

**Reuse decisions (never rebuild):** `SwarmSyncClient` (`src/swarmsync/client.ts`) reused as-is via its `apiBase`/`webBase`/`apiKey` options — broker mirrors SwarmSync's URL paths so no client code changes. `Extractor` interface (`src/extract/model.ts:23`) reused as-is. `src/logger.ts` redaction reused + extended (`aph_` token, bank patterns). `src/db/migrate.ts` runner reused for broker migrations. **The QBO connector reference adapter WRAPS the existing `src/qbo/write.ts` + `src/qbo/client.ts`** (delegates `createEntity`/`readEntity`/`queryExisting`/`attach`) — the tested write logic is reused verbatim; the `AccountingConnector` interface is a thin layer above it. Existing `postings` idempotency, read-back reconciliation, and `mappings` dimensions are reused as the canonical model's storage.

**No new source-of-truth conflicts from the platform seams:** the canonical model maps onto existing tables (`proposals`, `mappings`, `postings`, `reconciliation`) — it is a typed *view* over the current source of truth, not a second store. The connector interface adds no persistence. Verified against `specs/reference/ARCHITECTURE-ap-hub-platform.md#5.2`.

**Must not break (each maps to a regression test in §10):**
1. Guarantee 1 — no QBO write outside `src/qbo/write.ts`; Gmail never modified.
2. Guarantee 2 — the only outbound email is the locked-recipient gatekeeper forwarder (`send_lockdown`).
3. Guarantee 3 — QBO sandbox only; `QBO_ENV=production` hard-refused at config load (`src/config.ts:104`) (`no_prod_write`).
4. Guarantee 4 — no double-post, no double-forward.
5. **Guarantee 5 — nothing unscanned gets through; a proof-service outage HOLDS for review and never fails open** (`proof_fail_safe`, `gatekeeper_hold`, `proof_gate_posting`). **This is the guarantee this spec puts most at risk** — the broker becomes a new failure point in front of SwarmSync. A broker outage MUST be indistinguishable from a SwarmSync outage: hold, never pass.
6. Guarantee 6 — white-label = config only; no tenant value in code.
7. The existing Vitest suite passes at its current count, unchanged.
8. **Provider-neutrality of the core** — no provider-specific or OS-specific symbol leaks into AP-Hub Core (everything outside `src/connectors/**` and `src/host/**`). Enforced by the `lint:noleak` rule (§10). The QBO write path stays behind the connector interface, not called directly from new core code.

> **Test baseline — RESOLVED 2026-07-17: `212 tests pass across 28 files`** (ran `DATABASE_URL=postgres://aphub:aphub@127.0.0.1:5432/aphub npm test` against live Postgres). The brainstorm's "212" was correct; the ralph-guided-installer's "189" was stale. **Every later phase compares against 212 — a passing count below 212, or any existing test edited, is a build failure.**
>
> **Build-environment requirement (discovered at baseline):** vitest does **not** auto-load `.env`, so `test/setup.ts:9` falls back to `...:5433/aphub` (closed here) via `||=`. Build agents MUST run tests with `DATABASE_URL` set to the live instance (`...:5432/aphub`) in the environment, or point a Postgres at 5433. This is an env-setup requirement, not a code change — do not "fix" it by editing `test/setup.ts`.

---

## 1. Executive Summary

**What:** The foundation of a cross-platform, provider-neutral AP automation platform, built as a safe pilot. Three durable seams are laid — a provider-neutral `AccountingConnector` (proven by wrapping the existing QuickBooks Online code so QBD/Xero/Sage can slot in later without touching core), an OS-neutral `HostAdapter` (Windows built now, macOS compiled now and run later), and a host-neutral key **broker** (a small internet service holding Ben's Claude + SwarmSync keys so no tester machine ever does). Plus the Windows plumbing to run AP-Hub on a tester's PC and measure whether it stays alive.

**Why now:** Two forcing functions. (1) The 6-agent brainstorm concluded the installer architecture hinges on one unmeasured question — do target users leave their PCs on, and does a local database survive sleep/wake/reboot? — and recommended a pilot before finalizing. (2) The architecture audit found AP-Hub today **cannot boot without Ben's Claude key** and uses his SwarmSync key; on a stranger's PC those can be extracted and spent without limit. The owner's platform direction adds a third: the pilot must not hard-code Windows-only or QBO-only assumptions, because the real product is Windows **and** macOS across QBO, QuickBooks Desktop, Xero, and Sage Intacct. All three are addressed here by laying the seams now and proving them with one OS + one provider — the narrowest slice that de-risks the whole platform.

**Who for:** 3–5 named, known pilot testers (non-technical bookkeepers) plus Ben as the operator. Eventual product: any normal business user on Windows or macOS.

**Success number:** Three measured numbers from real machines within 30 days (online-hours %, watchdog recovery rate, Postgres corruption incident count), zero API keys on any tester's disk, and the QBO connector passing the provider-neutral contract suite unchanged in behavior.

**Build size:** ~19 days of agent work (~4 weeks; phase estimates in §18 sum to 19). The added ~6 days over the pure-broker pilot buys the provider-neutral + cross-platform seams that stop the pilot from becoming a Windows/QBO dead-end.

**What this deliberately is NOT:** not the final one-click installer (no Electron/signing/auto-update — Phase 2), not macOS execution (adapter compiled, run in Phase 1B), not the other three providers (interface only; adapters in 1B/1C), not folder scanning (designed, built 1B+), not any production accounting write (disabled platform-wide through the pilot). See §2 Do Not Build, §14, and `ARCHITECTURE-ap-hub-platform.md#11` for the full phase plan.

## 2. Scope & Do Not Build

**In scope:**

*Broker service (`broker/`):*
- `POST /v1/extract` — accepts an extraction request, calls Anthropic with the broker-held key, returns the raw model JSON.
- `POST /api/verify` — proxies SwarmSync Verify-API / AuditProof with the broker-held `ssk_` key.
- `POST /api/scan/invoices` — proxies SwarmSync InvoiceProof.
- `GET /api/proof/:id/export/verify` — proxies SwarmSync chain verification.
- `POST /v1/heartbeat` — accepts pilot telemetry (liveness, watchdog restarts, Postgres health).
- `GET /health` — liveness (db reachable).
- Bearer auth on every route except `/health`, using per-install tokens.
- Per-install rate limit and hard weekly spend cap; revocation.
- Broker migrations (`installs`, `heartbeats`, `spend_ledger`).
- Operator CLI: issue token, revoke token, list installs, report pilot metrics.

*ap-hub rewiring (broker mode):*
- `src/config.ts` — `BROKER_BASE_URL`, `BROKER_INSTALL_TOKEN` added; `ANTHROPIC_API_KEY`/`SWARMSYNC_API_KEY` become optional (broker mode) but remain usable (direct mode, for Ben's dev box + existing tests).
- `src/extract/model.ts` — `getBrokerExtractor()` implementing the existing `Extractor` interface.
- `src/pipeline/extract.ts:214` — chooses broker vs direct extractor from config.
- `src/services.ts` — `swarmsync()` points `SwarmSyncClient` at the broker in broker mode.
- `src/logger.ts` — redaction extended to the install token + bank/routing patterns.
- `.env.example` — port drift corrected (3000 → 3001 on the two redirect URIs and `PORT`), broker vars added.

*Provider-neutral + cross-platform seams (the platform foundation):*
- `src/connectors/` — `AccountingConnector` interface + `CapabilityMatrix` + `Unsupported` type (per `ARCHITECTURE-ap-hub-platform.md#4`); **QBO reference adapter that WRAPS existing `src/qbo/` code** (delegation only); a reusable connector **contract-test suite** the QBO adapter must pass. QBD/Xero/Sage adapters are **interface stubs only** in 1A (declare capabilities, throw `NotImplementedInPhase` on calls) so the contract shape is fixed but no adapter logic is built.
- `src/canonical/` — canonical AP model TypeScript types + mapping helpers onto `proposals.proposed_txn` (JSONB) and `mappings`; dimensions modeled as an extensible list (per the provider matrix — Intacct breaks fixed columns).
- `src/host/` — `HostAdapter` + `SecretStore` interfaces; **Windows adapter** (DPAPI, Task Scheduler, `%LOCALAPPDATA%`, port probe); **macOS adapter** (Keychain, LaunchAgent, `~/Library/...`) compiled + type-checked, exercised Phase 1B; a `HostAdapter` contract-test suite.
- `src/broker/` — host-neutral `BrokerClient` (used by the extractor + swarmsync composition); `BROKER_BASE_URL` is config, never a Render assumption.
- `src/auth/tokens.ts` — `Provider` enum widened to include `xero|sage_intacct|qbd` (enum only).
- `migrations/00X` (additive) — generalize `postings.qbo_*` columns behind a back-compat VIEW; add `connections` table. No drop.
- `eslint` — `lint:noleak` rule forbidding provider/OS-specific identifiers in core (`ARCHITECTURE-ap-hub-platform.md#9`).

*Pilot harness (`harness/`):*
- `install-pilot.ps1` — non-admin install to `%LOCALAPPDATA%\APHub`: portable Node, portable Postgres 16, `initdb`, migrations, `.env` generation, consent screen, watchdog registration.
- `start-aphub.ps1` — supervisor: starts and monitors **three** processes (Postgres, backend :3001, Next :3000); restarts a dead child; emits a heartbeat every 60s.
- `aphub-watchdog.xml` — Task Scheduler definition: on-logon + every-5-minutes trigger, non-elevated, restart-on-failure.
- `uninstall-pilot.ps1` — unregister task, stop processes, delete data dir.

### Do Not Build

- **No Electron shell** — reason: the brainstorm's own conclusion is that the shell choice (Electron vs. tray-plus-browser) is separable from and lower-stakes than the durability question this pilot answers, and SpiderSpark's dissent (40% probability) is still open. Building Electron now commits to the unresolved side of a live dissent. Phase 2.
- **No code signing / no certificate purchase** — reason: costs money and days of identity verification, and only matters for distribution to strangers. Pilot testers are known people who can click through SmartScreen with Ben on the phone. The SmartScreen-tolerance assumption stays explicitly unverified (see §14). Phase 2.
- **No auto-update (`electron-updater`) or release feed** — reason: depends on Electron and signing, neither of which exist here. Pilot updates are Ben re-running `install-pilot.ps1`. Phase 2.
- **No Windows Service, no elevation, no admin-rights install** — reason: the brainstorm converged (5 of 6 agents) that a *non-elevated* Task Scheduler watchdog closes the silent-death gap without service/elevation complexity. This spec adopts exactly that, per owner decision, not gated on pilot results.
- **No QBO production write path** — reason: `src/config.ts:104` hard-refuses `QBO_ENV != sandbox` and that is guarantee 3. Pilot is sandbox-only by owner decision. Phase 3, separately specced, far larger.
- **No migration of Gmail OAuth to installed-app/PKCE loopback** — reason: the current web-client + `http://localhost:3001` redirect works for a pilot where Ben adds the 3–5 testers as test users on his own consent screen. Moving to an installed-app client type is required before distribution to strangers but is not required to get the pilot's three numbers. Phase 2. Recorded as a limitation in §14.
- **No broker-side storage of email content, attachments, invoice data, or extraction results** — reason: this is a key-custody and telemetry proxy, not a data platform. Storing financial data off Ben's premises is exactly the compliance burden that got DarkMirror's cloud-relay pivot rejected in the brainstorm. The broker forwards and forgets. Enforced by test (§10).
- **No cloud-relay pivot (moving the pipeline off the desktop)** — reason: DarkMirror's Phase 4 proposal, rejected by DarkMirror's own verdict for this context. Held in reserve as the escalation path if this pilot shows unrecoverable local-Postgres problems. §17.
- **No multi-tenant broker, no billing, no signup, no user accounts** — reason: 3–5 known testers, tokens issued by hand via CLI. Anything more is speculative scale.
- **No macOS *execution* in 1A** — reason: the macOS `HostAdapter` is compiled and type-checked in 1A so the Windows work cannot hard-code OS assumptions, but it is *exercised* on a real Mac in Phase 1B. Building both harnesses at once doubles the pilot surface before the first measurement exists (`ARCHITECTURE-ap-hub-platform.md#2`).
- **No QBD / Xero / Sage Intacct adapter *logic* in 1A** — reason: only the `AccountingConnector` *interface* + QBO reference adapter are built now; the other three are capability-declaring stubs that throw `NotImplementedInPhase`. QBD bridge = Phase 1C (needs a Windows/QBWC host + disposable company); Xero/Sage = Phase 1B (need test orgs; Xero before Sage per sandbox-friction, `provider-research-2026-07-17.md#D`).
- **No production accounting write for ANY provider** — reason: QBO `QBO_ENV=production` is hard-refused (`src/config.ts:104`, guarantee 3); QBD/Xero/Sage writes stay disabled platform-wide through the entire pilot (1A–1C). Sandbox/test/disposable targets only. Production writes are Phase 2+, each far larger and separately specced.
- **No filesystem / folder / cloud-storage scanning** — reason: the pilot ingests from Gmail only. The bounded, permission-based, metadata-first discovery system is *designed* (threat model, `ARCHITECTURE-ap-hub-platform.md#8`) but built Phase 1B+. No unrestricted scanning ever.
- **No `.QBW` file access of any kind** — reason: supported QBD integration never touches the company file directly (safe by construction, `provider-research-2026-07-17.md#A.8`); and QBD isn't built until 1C regardless.
- **No canonical-model migration that drops or rewrites existing columns** — reason: the model maps onto existing JSONB + tables; column generalization ships behind a back-compat VIEW, additively. Rewriting the tested schema is out of scope and would risk the guarantee tests.

## 3. Business Context & Acceptance Criteria

**Goal:** Answer the brainstorm's Crux with measured data, without ever putting Ben's API keys on someone else's computer.

**Target numbers (from the brainstorm's own falsifiers):** online-hours **>60–70%** of business hours → tray-app+watchdog is sufficient, proceed to Phase 2. **>30–40%** logged-out/off, OR any un-recovered crash, OR any Postgres corruption incident → the recommendation flips to a heavier design (real service, or the cloud-relay escalation).

### Acceptance Criteria

*Secret custody:*
- [ ] `grep -r "sk-ant\|ssk_live" %LOCALAPPDATA%\APHub` on a pilot machine returns **zero matches** — FAIL if any match, including in `.env`, logs, or crash dumps.
- [ ] With `BROKER_BASE_URL` set and `ANTHROPIC_API_KEY` absent from the environment, `boot()` starts successfully and an extraction completes end-to-end — FAIL if config throws `ANTHROPIC_API_KEY is required`.
- [ ] A `POST /v1/extract` with no `Authorization` header returns exactly **401 UNAUTHENTICATED** — FAIL if 200, 403, 404, or 500.
- [ ] A `POST /v1/extract` with a revoked token returns exactly **403 TOKEN_REVOKED** — FAIL if 200 or 401.
- [ ] An install that has exceeded its weekly spend cap receives exactly **429 SPEND_CAP_EXCEEDED** and Anthropic is **not** called — FAIL if the upstream call is made (assert on the mock).

*Guarantee 5 — the dangerous one:*
- [ ] With the broker returning 500 on `/api/verify`, a proposal **holds for review** and does **not** reach `ready`, and an `exceptions` row is written — FAIL if the proposal posts, if it silently passes, or if no exception row appears.
- [ ] With the broker unreachable (connection refused), same as above — FAIL on any fail-open.
- [ ] With the broker returning a malformed/empty proof body, same as above — FAIL if the malformed body is treated as a pass.
- [ ] The existing `proof_fail_safe`, `gatekeeper_hold`, and `proof_gate_posting` tests pass unmodified — FAIL if any is edited to accommodate the broker.

*Watchdog + harness:*
- [ ] After `Stop-Process -Force` on the backend, the supervisor restarts it within **90 seconds** and a `watchdog_restart` heartbeat reaches the broker — FAIL if no restart or no telemetry.
- [ ] After killing the **supervisor itself**, Task Scheduler relaunches it within **5 minutes** (the trigger interval) — FAIL if it stays dead.
- [ ] After a full reboot with auto-login, all three processes are alive within **3 minutes** of desktop — FAIL otherwise.
- [ ] After Windows sleep→wake, Postgres accepts a `SELECT 1` and `pg_isready` returns 0 — FAIL on any connection error requiring manual intervention.
- [ ] `install-pilot.ps1` completes on a non-admin Windows account with **no UAC prompt** — FAIL if elevation is requested at any point.

*Telemetry:*
- [ ] After 7 days on one machine, `npm --prefix broker run cli -- pilot-report` prints all three numbers with the sample size and the date range — FAIL if any number is absent or hardcoded.
- [ ] The broker's `heartbeats` table contains no column and no row holding email content, vendor names, amounts, or attachment bytes — FAIL on any.

*Provider-neutral + cross-platform seams:*
- [ ] The QBO reference adapter passes the `AccountingConnector` contract suite (read vendors/accounts, create a bill in sandbox, `readBack` confirms `externalId`+`revision`, `verifyCompanyIdentity` returns `match`) — FAIL if any contract test fails.
- [ ] End-to-end sandbox posting through the connector interface produces the **same** `postings` row, idempotency behavior, and `proposal_vs_created` reconciliation row as the pre-refactor direct path — FAIL on any behavioral difference (the existing `test/posting.test.ts` must pass unmodified).
- [ ] Capability mapping: a canonical field a provider's `capabilities()` marks unrepresentable resolves to an `Unsupported` response that is surfaced + audit-logged (tested via the QBO adapter against a field QBO lacks, e.g. an Intacct-style custom dimension) — FAIL if it is silently dropped. (Stub providers throw `NotImplementedInPhase` on `read`/`create`; this criterion is about capability discovery, not a live stub call.)
- [ ] `npm run lint:noleak` passes: no provider-specific identifier (`Bill`, `SyncToken`, `Realm`, `qbo`, `.QBW`, `Xero`, `Intacct`) outside `src/connectors/**`; no OS-specific identifier outside `src/host/**` — FAIL on any leak into core.
- [ ] `npm run typecheck` passes with the macOS `HostAdapter` implementation present (compiled, even though unexercised) — FAIL if macOS code doesn't type-check.
- [ ] `Provider` enum includes `qbo|gmail|xero|sage_intacct|qbd` and existing token storage/tests still pass — FAIL on regression.

### Definition of Done

```
DONE means ALL true in the DEPLOYED environment, with an artifact per item
(HTTP response, DB row, screenshot, log line):
1. [each acceptance criterion above, observed live]
NOT done if:
- Verified only locally ("works on my machine" is not done)
- "Code looks correct" / "tests should pass" — only observed behavior counts
- Any must-not-break item is untested
```

For this spec, "deployed environment" means: the broker running on its real Render URL over HTTPS, and the harness installed on at least one real Windows machine that is not the dev box.

## 4. Architecture & System Integration

**Layered platform architecture** (three seams — `AccountingConnector`, `HostAdapter`, `BrokerClient` — with QBO/Windows/Render as the Phase-1A reference implementations): see `specs/reference/ARCHITECTURE-ap-hub-platform.md#1`. The diagram below is the **runtime topology of a single pilot install** (the concrete thing Phase 1A stands up); the seams are what make it portable to macOS and to the other three providers without touching core.

```
PILOT MACHINE (%LOCALAPPDATA%\APHub, no admin)
  Task Scheduler task "APHub Watchdog" (non-elevated; on-logon + every 5 min)
       │ ensures alive
       ▼
  start-aphub.ps1  (supervisor)
       ├── postgres.exe  -D data\pg  -p 55432   (child, portable binaries)
       ├── node src\index.ts        :3001       (child — pipeline + OAuth callbacks)
       ├── node next start          :3000       (child — UI)
       └── heartbeat every 60s ──────────────┐
                                             │ HTTPS + Bearer <install token>
  ap-hub pipeline ── extract ────────────┐   │
                  └─ proof (SwarmSync) ──┤   │
                                         ▼   ▼
                              BROKER (Render, HTTPS)
                                 ├── holds ANTHROPIC_API_KEY  ──► api.anthropic.com
                                 ├── holds SWARMSYNC_API_KEY  ──► api.swarmsync.ai
                                 └── Postgres: installs · heartbeats · spend_ledger

  UNCHANGED, still direct from the pilot machine (no broker involvement):
    Gmail API · QBO sandbox API · Telegram
```

**Why Gmail/QBO/Telegram do not go through the broker:** those credentials are already per-install and per-tenant (each tester connects their own Gmail and their own QBO sandbox via OAuth — the tokens are theirs, encrypted at rest with the local `ENCRYPTION_KEY`). Only Anthropic and SwarmSync use *Ben's* keys, and only those two need brokering. Routing the rest through the broker would move tenant financial data off-premises for no custody benefit — explicitly out of scope (§2).

**Integration points:**
| Point | Direction | Auth | Failure behavior |
|---|---|---|---|
| ap-hub → broker `/v1/extract` | out | Bearer install token | Exception row `extract_failed`; proposal does not reach `ready` |
| ap-hub → broker `/api/verify` etc. | out | Bearer install token | **HOLD for review** (guarantee 5); never fail-open |
| ap-hub → broker `/v1/heartbeat` | out | Bearer install token | Best-effort; a failed heartbeat must never affect the pipeline |
| broker → Anthropic | out | `ANTHROPIC_API_KEY` (broker env) | 502 to caller; caller writes exception |
| broker → SwarmSync | out | `SWARMSYNC_API_KEY` (broker env) | Upstream status passed through verbatim; caller holds |

**Critical design rule:** the broker is a **pass-through**. It must never synthesize, default, cache, or "helpfully" fill in a proof result. On any upstream failure it returns an error status — never a success body. A broker that invents a passing proof breaks guarantee 5 silently and totally. Enforced by test (§10).

## 5. User Flows & Happy Path

**Flow A — Ben onboards a pilot tester (happy path)**
- Actor: Ben (operator). Precondition: broker deployed; tester's Google account added as a test user on Ben's OAuth consent screen; tester's QBO sandbox exists.
1. Ben runs `npm --prefix broker run cli -- issue-token --install "tester-jane"` → prints a one-time token.
2. Ben sends the tester a zip (harness + token) and joins a screen-share.
3. Tester runs `install-pilot.ps1`; a **consent screen** lists exactly what telemetry is collected and requires typing `I AGREE` to continue.
4. Script installs portable Node + Postgres to `%LOCALAPPDATA%\APHub`, runs `initdb`, applies migrations, writes `.env` (broker URL + token; **no API keys**), registers the Task Scheduler task, starts the supervisor.
5. Tester's browser opens `http://localhost:3000/onboarding`; they complete Gmail + QBO sandbox consent (real Google/Intuit screens — no bypass exists, per the research brief).
6. Postcondition: three processes alive; heartbeats arriving at the broker; `installs.last_seen_at` updating.

**Flow B — Extraction through the broker (happy path, the AI agent is the "user")**
- Actor: the `extract` pg-boss job. Precondition: an attachment awaiting extraction; broker reachable.
1. Job calls `getBrokerExtractor().extract({bytes, mime, ...})`.
2. Broker authenticates the token, checks revocation, checks the spend cap.
3. Broker calls Anthropic with its own key; records estimated spend in `spend_ledger`.
4. Broker returns the raw model JSON verbatim.
5. Pipeline validates/normalizes exactly as it does today (`validateRaw`, `normalizeExtraction` — unchanged pure functions).
- Postcondition: identical to today's direct-mode behavior. The pipeline cannot tell the difference.

**Flow C — Proof service unreachable (the guarantee-5 alternate)**
1. `gatekeep`/`posting` calls the broker's `/api/verify`; broker is down (or SwarmSync behind it is down).
2. `SwarmSyncClient` exhausts its existing retry/backoff and throws — unchanged code, unchanged behavior.
3. Pipeline writes a typed `exceptions` row and **holds** the item.
- Postcondition: nothing posts, nothing forwards, an alert fires. **A broker outage is indistinguishable from a SwarmSync outage.** This is the whole safety argument for putting a proxy in front of a proof service.

**Flow D — Silent death and recovery (the failure the brainstorm exists to fix)**
1. Tester right-clicks the tray/console and force-quits, or Windows kills the supervisor.
2. Task Scheduler's 5-minute trigger fires and relaunches `start-aphub.ps1`.
3. Supervisor finds no live children, restarts all three, emits `watchdog_restart` with `reason=cold_start`.
- Postcondition: recovered within 5 minutes, **and the death is visible in telemetry** — which is exactly what DarkMirror flagged as missing (a dead process produces no exception row; only external observation catches it).

## 6. Data Models & Schema

Broker Postgres only. ap-hub's schema is **unchanged** (no migration in this spec).

```sql
-- installs: one row per pilot machine
id            UUID PRIMARY KEY DEFAULT gen_random_uuid()
label         TEXT        NOT NULL UNIQUE       -- 'tester-jane'
token_sha256  TEXT        NOT NULL UNIQUE       -- SHA-256 of the bearer token; plaintext never stored
revoked_at    TIMESTAMPTZ NULL
weekly_cap_usd NUMERIC(10,2) NOT NULL DEFAULT 5.00
created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
last_seen_at  TIMESTAMPTZ NULL

-- heartbeats: liveness telemetry. NO business data, ever.
id          BIGSERIAL PRIMARY KEY
install_id  UUID        NOT NULL REFERENCES installs(id) ON DELETE CASCADE
observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
event       TEXT        NOT NULL CHECK (event IN ('alive','watchdog_restart','pg_health','shutdown'))
pg_ok       BOOLEAN     NULL
detail      TEXT        NULL CHECK (detail IS NULL OR length(detail) <= 200)
tz_offset_minutes INT   NULL

-- spend_ledger: enforces the cap
id          BIGSERIAL PRIMARY KEY
install_id  UUID        NOT NULL REFERENCES installs(id) ON DELETE CASCADE
occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
upstream    TEXT        NOT NULL CHECK (upstream IN ('anthropic','swarmsync'))
est_usd     NUMERIC(10,4) NOT NULL DEFAULT 0
```

**Validation rules:** `event` is a closed enum (CHECK). `detail` is capped at 200 chars and is for error codes only — a length cap plus a test (§10) is the mechanical defense against business data leaking into telemetry. `token_sha256` is a hash; the broker never stores a usable token.

**Valid heartbeat:** `{"event":"watchdog_restart","pg_ok":true,"detail":"backend_exit_1","tz_offset_minutes":-300}`
**Invalid heartbeat (rejected 400 VALIDATION):** `{"event":"invoice_seen","detail":"Acme Corp invoice #4471 for $2,300.00"}` — `event` not in enum; and even with a legal event this `detail` exceeds nothing but *is* business data, which is why §10 asserts on content, not just length.

## 7. Error Handling & Edge Cases

| Scenario | Status | Code | Response / Recovery |
|---|---|---|---|
| No `Authorization` header | 401 | `UNAUTHENTICATED` | `{"error":{"code":"UNAUTHENTICATED"}}`. No upstream call. |
| Unknown token | 401 | `UNAUTHENTICATED` | Same shape. Constant-time compare; do not reveal existence. |
| Revoked token | 403 | `TOKEN_REVOKED` | Ben re-issues. No upstream call. |
| Weekly cap exceeded | 429 | `SPEND_CAP_EXCEEDED` | `Retry-After` = seconds to window reset. **No upstream call.** Caller writes an exception row and holds. |
| Rate limit (>60 req/min/install) | 429 | `RATE_LIMITED` | `Retry-After: 60`. |
| Malformed request body | 400 | `VALIDATION` | Zod issues, field paths only, never values. |
| Anthropic upstream 5xx/timeout | 502 | `UPSTREAM_FAILED` | Verbatim upstream status in `detail`. Caller → `exceptions` row `extract_failed`. **Never a synthesized extraction.** |
| SwarmSync upstream 5xx/timeout | 502 | `UPSTREAM_FAILED` | Caller's existing retry/backoff runs, then **HOLD**. **Never a synthesized proof.** |
| Broker itself down / DNS fail / TLS fail | — | (connection error) | `SwarmSyncClient` throws after existing retries → **HOLD** (guarantee 5). Extraction → exception row. |
| Broker Postgres down | 503 | `DEGRADED` | `/health` returns 503. Proxy routes **fail closed** — a broker that cannot check revocation or the spend cap must not call upstream. |
| Heartbeat fails to send | — | — | Logged locally at `warn`, dropped. **Must never block or crash the pipeline.** |

**Edge cases:**
- **Clock skew / DST on the tester's machine** — heartbeats carry `tz_offset_minutes`; online-hours are computed broker-side from `observed_at` (server clock) so a wrong local clock cannot corrupt the metric.
- **Two supervisors racing** (task fires while one is already running) — supervisor takes an exclusive lock on `%LOCALAPPDATA%\APHub\run\supervisor.lock`; second instance exits 0 silently. Task Scheduler's own `MultipleInstancesPolicy=IgnoreNew` is belt-and-braces.
- **Port 3000/3001/55432 already taken** — installer probes before writing `.env`; on conflict it fails loudly with the occupying PID and process name rather than silently picking another port (a silently-moved port breaks the registered OAuth redirect URI).
- **`initdb` blocked by antivirus** — install script checks `pg_isready` after start and, on failure, prints the Defender exclusion command and exits non-zero. (This is one of the things the pilot is meant to discover — per Archaeologist's note that the pilot's real value is install-time compatibility.)
- **Tester revokes Gmail/QBO consent mid-pilot** — existing pipeline behavior, unchanged: exception row.
- **Disk full during `initdb`** — script checks for ≥2 GB free before starting and exits with a plain-English message.
- **Token leaked from a tester's disk** — bounded by design: revoke via CLI (effective within one request), weekly cap bounds worst-case loss to `weekly_cap_usd`. This bounded blast radius is the entire justification for the broker over baking keys.

## 8. Performance & Scalability

Scale is **3–5 machines**. Explicitly not designed for more; the broker gets replaced or hardened before any real distribution (§14).

| Metric | Target | Rationale |
|---|---|---|
| Broker proxy overhead (broker time minus upstream time), p95 | **< 150 ms** | Extraction is a multi-second vision call; 150 ms is noise. FAIL if the broker adds more than the pipeline's existing tolerance. |
| `/v1/heartbeat` p95 | < 200 ms | Trivial insert. |
| Broker throughput | 5 installs × 60 req/min ceiling = **300 req/min worst case** | Render free tier handles this comfortably. |
| Supervisor restart detection | ≤ 30 s (poll interval) | With the 5-min Task Scheduler trigger as backstop → 90 s / 5 min acceptance bounds in §3. |
| Heartbeat volume | 1/min × 5 installs × 30 days ≈ **216k rows** | Trivial for Postgres. No partitioning, no retention job. |
| Pilot install footprint | < 500 MB (portable Node ~90 MB + Postgres ~300 MB + app) | Quantifier's Fermi estimate was 300–500 MB; this pilot **measures** it rather than assuming. |

**Cost budget:** Render free web service + free Postgres = **$0/mo**. Anthropic spend bounded by the cap: 5 installs × $5/week = **$25/week worst case, hard-enforced** — this cap is the number that makes the whole pilot financially safe, and it is enforced in code (§7), not by trust. SwarmSync spend is against Ben's existing plan.

> Render's free tier idles a service after inactivity and cold-starts on the next request (tens of seconds). That is acceptable — a cold-start delay on an extraction is slow, not unsafe, and a cold-start timeout on a proof call **holds** (guarantee 5) rather than failing open. If cold starts prove disruptive, upgrade to Render's paid tier ($7/mo); do not add a keep-alive pinger, which would just burn free-tier hours.

## 9. Security & Compliance

**Who can do what:**
| Actor | Can | Cannot |
|---|---|---|
| Pilot install (bearer token) | Call the 4 proxy routes + heartbeat, for itself only | Read another install's data; read the API keys; exceed its cap; un-revoke itself |
| Ben (operator, CLI + host shell) | Issue/revoke tokens, read telemetry, set caps | — |
| Anyone unauthenticated | `GET /health` | Everything else |

**Secret storage:**
| Secret | Lives | Never |
|---|---|---|
| `ANTHROPIC_API_KEY` | Render environment variable | Not in git, not in the harness zip, not on any tester machine, not in logs |
| `SWARMSYNC_API_KEY` | Render environment variable | Same |
| Install token | Tester's `%LOCALAPPDATA%\APHub\.env`, file ACL'd to that user | Not in git; hash-only in the broker DB |
| `ENCRYPTION_KEY` (per install) | Tester's `.env`, generated per install at install time | Never shared between installs; never sent to the broker |
| Gmail/QBO OAuth tokens | Tester's local Postgres, encrypted with their `ENCRYPTION_KEY` (existing behavior) | Never sent to the broker |

**Redaction:** `src/logger.ts` already redacts `ssk_`, Telegram tokens, and bearer tokens. Extend it to the install-token prefix (`aph_`) and add a test — per CLAUDE.md's standing rule to extend redaction when adding secrets.

**Transport:** HTTPS only (Render terminates TLS). The broker rejects plaintext. `BROKER_BASE_URL` is validated as `https://` at config load — with a single explicit exception for `http://127.0.0.1` in tests.

**Token design:** 32 bytes from `crypto.randomBytes`, base64url, prefixed `aph_`. Stored as SHA-256. Compared in constant time. Shown once at issue.

**Data protection:** the broker stores **no** business data by design (§2, §6), enforced by a content assertion in §10. Telemetry is liveness only. Testers give informed consent at install (Flow A step 3) with the exact collected fields listed. This is not a legal formality — it is someone's work computer.

**Compliance that actually applies:** **None formal.** No GDPR/SOC2/PCI regime binds a 3–5 person pilot with no EU data subjects, no card data, and no customer contracts. Saying otherwise would be spec theater. The real obligations are ethical and stated above: informed consent, no business data off-premises, bounded blast radius, revocability.

## 10. Testing Strategy

All tests runnable by ralph and truth-fix-loop. Vitest for both trees; Playwright unchanged.

**Phase 0 — baseline (blocking, before any code changes):**
- Start Postgres, run `npm test`, **record the true passing count**. This number is the baseline every later phase compares against. Resolves the 212-vs-189 discrepancy.

**Must-not-break regression tests (one per grounding item):**
| Guarantee | Test | Assertion |
|---|---|---|
| 1 — no QBO write outside `write.ts` | existing `test/posting.test.ts` + `test/lockdown.test.ts` | Pass **unmodified** |
| 2 — send lockdown | existing `test/lockdown.test.ts` (`send_lockdown`) | Pass unmodified |
| 3 — sandbox only | existing `test/lockdown.test.ts` (`no_prod_write`) | Pass unmodified; plus a new case: broker vars set + `QBO_ENV=production` still throws |
| 4 — no double-post/forward | existing `test/posting.test.ts`, `test/gatekeeper.test.ts` | Pass unmodified |
| **5 — proof fail-safe** | existing `proof_fail_safe` (`test/digest.test.ts`, `test/extract-pipeline.test.ts`, `test/gatekeeper.test.ts`, `test/mapping-pipeline.test.ts`), `gatekeeper_hold` (`test/gatekeeper.test.ts`), `proof_gate_posting` (`test/posting.test.ts`) | Pass unmodified — **plus 4 new broker-outage cases below**. Note `proof_fail_safe` appears in **four** files: the broker sits in front of the proof service for all of them, so all four are regression surface, not just the gatekeeper one. |
| 6 — white-label config-only | existing `test/anchor-whitelabel.test.ts` (`white_label_install`) | Pass unmodified |
| Suite baseline | `npm test` | Count ≥ the Phase-0 baseline; **zero existing tests edited** |

**New tests — guarantee 5 under broker failure (`test/broker-fail-safe.test.ts`), the highest-value tests in this spec:**
- Broker returns 500 on `/api/verify` → item holds, `exceptions` row written, nothing reaches `ready`.
- Broker connection refused → same.
- Broker returns `200` with an empty/malformed body → **held, not treated as a pass** (the nastiest fail-open shape).
- Broker returns `200` with a well-formed but *fabricated* pass while upstream actually failed → this must be impossible by construction; the test asserts the broker's upstream-error path cannot emit a 2xx (broker-side unit test).

**New broker tests (`broker/test/`):**
- Auth matrix: missing / unknown / revoked / valid token → 401 / 401 / 403 / 200.
- Spend cap: at cap → 429 and **upstream mock not called** (assert call count === 0).
- Rate limit: 61st request in a minute → 429.
- Pass-through fidelity: upstream body returned byte-identical; upstream non-2xx never becomes a 2xx.
- Fail-closed: broker DB unreachable → 503, upstream mock not called.
- **Telemetry content assertion:** post a heartbeat whose `detail` contains `"Acme Corp"`, `"$2,300.00"`, and an email address; assert the stored row contains none of them (rejected or stripped). This is the mechanical guard on "no business data leaves the machine."
- Redaction: a log line containing an `aph_` token renders redacted.

**Integration (real DB):** broker migrations up/down against a real Postgres; `installs`/`heartbeats`/`spend_ledger` constraints enforced (enum CHECK rejects a bad `event`).

**Harness tests (`harness/test/`, Pester or PowerShell asserts — logic-level, not a real reboot):**
- Port-conflict probe returns non-zero and names the occupying PID.
- Lock file prevents a second supervisor.
- Dead-child detection triggers a restart and emits `watchdog_restart`.

**Manual, on a real machine (the acceptance criteria in §3 that no unit test can prove):** non-admin install with no UAC; kill-backend → restart ≤90 s; kill-supervisor → Task Scheduler recovery ≤5 min; reboot → all three alive ≤3 min; sleep/wake → Postgres healthy; `grep` for keys returns zero. Each produces an artifact (screenshot or log) per the Definition of Done.

**Not tested here:** long-tail Postgres corruption over months across hundreds of machines. **No test in this spec can address it** — Archaeologist's dissent survived Phase 2 unshaken precisely because a short small-N pilot has near-zero power against it. It stays a monitored post-launch risk (§14), not a solved one.

## 11. Deployment & Rollout

**Platform: Render** (free web service + free Postgres), via `broker/render.yaml`.

**Deploy:** push to `main` → Render auto-deploys from the blueprint. Manual: `render deploys create <service-id>`.

**Env vars (exact names, set in the Render dashboard — never in git):**
| Var | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Ben's Claude key |
| `SWARMSYNC_API_KEY` | Ben's `ssk_live_…` key |
| `SWARMSYNC_API_BASE` | `https://api.swarmsync.ai` |
| `SWARMSYNC_WEB_BASE` | `https://swarmsync.ai` |
| `DATABASE_URL` | Auto-injected by Render Postgres |
| `LOG_LEVEL` | `info` |
| `PORT` | Auto-injected by Render |

**Verify live:** `curl https://<service>.onrender.com/health` → `200 {"status":"ok","db":true}`. Then `curl -H "Authorization: Bearer aph_…" -X POST …/v1/heartbeat -d '{"event":"alive"}'` → `201`. Then confirm the row: `SELECT * FROM heartbeats ORDER BY id DESC LIMIT 1`.

**Rollback:** Render dashboard → Deploys → "Rollback to this version" on the previous deploy. Migrations are additive-only in this spec (three new tables, no ALTER of anything existing), so a code rollback needs no schema rollback. `DOWN` scripts exist and are tested regardless (§13).

**Pilot rollout:** one machine first (Ben's own spare, or one tester with the highest tolerance) — run for 48 h and confirm heartbeats + watchdog recovery before touching the other testers. Then the remaining 2–4. There is no canary/blue-green here; Render doesn't do it and 5 installs don't need it.

**Kill switch:** `npm --prefix broker run cli -- revoke --all` stops every install from spending against Ben's keys within one request. This is the thing that makes the pilot safe to start.

## 12. API Documentation

All routes require `Authorization: Bearer aph_…` except `/health`. All errors: `{"error":{"code":"…","message":"…"}}`.

```
GET /health — Auth: none
200: { status: "ok", db: true } | 503 { status: "degraded", db: false }

POST /v1/extract — Auth: bearer
Req: an Anthropic Messages API request object { model, max_tokens, messages, ... }
     (built by ap-hub's getBrokerExtractor via the SHARED buildAnthropicRequest() — so the
     extraction prompt + vision-content logic lives in ONE place, src/extract/model.ts. The
     broker is a thin passthrough: it injects the Anthropic key and forwards to
     api.anthropic.com/v1/messages. This replaces the earlier {bytes_b64,...} draft shape —
     forwarding the built request keeps the broker from duplicating prompt logic, per §4's
     thin-passthrough rule. [Implemented CHUNK_3/CHUNK_4, 2026-07-18.])
200: <raw Anthropic Messages response, verbatim — ap-hub parses the text block → JSON>
400 VALIDATION (body not a JSON object) | 401 UNAUTHENTICATED | 403 TOKEN_REVOKED | 429 RATE_LIMITED | 429 SPEND_CAP_EXCEEDED | 502 UPSTREAM_FAILED | 503 DEGRADED
Rate limit: 60/min/install. Spend: counted against weekly_cap_usd.

POST /api/verify — Auth: bearer   (path mirrors SwarmSync exactly so SwarmSyncClient needs no code change)
Req: <passed through verbatim>
200: <SwarmSync response, verbatim> | 401 | 403 | 429 | 502 UPSTREAM_FAILED | 503 DEGRADED

POST /api/scan/invoices — Auth: bearer   (note: public/unauthed upstream; the BROKER still requires a token)
Req: { invoices, vendorMaster?, paymentHistory?, poRegister? }
200: <verbatim> | 401 | 403 | 429 | 502 | 503

GET /api/proof/:id/export/verify — Auth: bearer
200: <verbatim> | 401 | 403 | 404 | 502 | 503

POST /v1/heartbeat — Auth: bearer
Req: { event: "alive"|"watchdog_restart"|"pg_health"|"shutdown", pg_ok?: boolean,
       detail?: string (≤200, error codes only — NEVER business data), tz_offset_minutes?: number }
201: { ok: true }
400 VALIDATION | 401 | 403 | 429 RATE_LIMITED
Rate limit: 5/min/install.
```

**Operator CLI (`npm --prefix broker run cli -- <cmd>`):**
```
issue-token --install <label> [--cap-usd 5.00]   → prints the token ONCE
revoke --install <label> | --all                 → immediate
list-installs                                    → label, last_seen_at, week-to-date spend, revoked
pilot-report [--days 7]                          → the three numbers + sample size + date range
```

## 13. Database Migrations

Two migration sets, both additive and reversible.

**A. ap-hub schema — ONE additive migration (Phase 4).** The canonical-model seam requires generalizing three `postings` columns and adding one table. It is **strictly additive** — no existing column is dropped, no existing row rewritten, existing tests keep passing via a compatibility view:
```sql
-- migrations/006_provider_neutral.sql (UP)
ALTER TABLE postings RENAME COLUMN qbo_type  TO entity_type;
ALTER TABLE postings RENAME COLUMN qbo_id    TO external_id;
ALTER TABLE postings RENAME COLUMN sync_token TO revision;
CREATE VIEW v_postings_qbo AS                       -- back-compat: old column names still queryable
  SELECT *, entity_type AS qbo_type, external_id AS qbo_id, revision AS sync_token FROM postings;
CREATE TABLE connections (                           -- non-OAuth connection metadata (e.g. a QBD bridge)
  id serial PRIMARY KEY, tenant_id int NOT NULL, provider text NOT NULL,
  connection_class text NOT NULL CHECK (connection_class IN ('cloud','local_desktop')),
  detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
```
```sql
-- migrations/006_provider_neutral.down.sql (DOWN) — fully reversible
DROP TABLE IF EXISTS connections;
DROP VIEW IF EXISTS v_postings_qbo;
ALTER TABLE postings RENAME COLUMN revision TO sync_token;
ALTER TABLE postings RENAME COLUMN external_id TO qbo_id;
ALTER TABLE postings RENAME COLUMN entity_type TO qbo_type;
```
A column **rename** (not drop+add) preserves data; the view keeps any missed references working; code and tests are migrated to the new names in the same phase. The rename is chosen over new columns to avoid two names for one value (a source-of-truth smell). Rollback needs no data reconstruction. **No other ap-hub migration in this spec.** The canonical model's remaining fields live in existing JSONB (`proposals.proposed_txn`), needing no migration (`ARCHITECTURE-ap-hub-platform.md#5.2`).

**B. Broker schema.** Broker migrations reuse the repo's runner pattern (`src/db/migrate.ts`).

`broker/migrations/001_init.sql` (UP) — creates `installs`, `heartbeats`, `spend_ledger` exactly as in §6, plus:
```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;              -- gen_random_uuid()
CREATE INDEX idx_heartbeats_install_time ON heartbeats (install_id, observed_at DESC);
CREATE INDEX idx_spend_install_time      ON spend_ledger (install_id, occurred_at DESC);
CREATE UNIQUE INDEX idx_installs_token   ON installs (token_sha256);
```
Both indexes back the only two queries that run repeatedly: the online-hours rollup and the weekly-cap check.

`broker/migrations/001_init.down.sql` (DOWN):
```sql
DROP TABLE IF EXISTS spend_ledger;
DROP TABLE IF EXISTS heartbeats;
DROP TABLE IF EXISTS installs;
```
Safe to run: all three tables are created by this spec and nothing else references them. Per the owner's database rules, `DROP` is acceptable here **only** because the tables are new in this migration — there are no live references to check.

**Verification query (run after UP, must return 3):**
```sql
SELECT count(*) FROM information_schema.tables
WHERE table_schema='public' AND table_name IN ('installs','heartbeats','spend_ledger');
```

Tested on a scratch database before the Render deploy; UP → DOWN → UP must be clean.

## 14. Known Limitations, Open Questions & Future Work

**Known limitations (accepted, not defects):**
1. **The broker is a new single point of failure.** If it's down, no extraction happens and every proof call holds. That is *safe* (guarantee 5) but it means a broker outage stops the pipeline. Accepted: the alternative is Ben's keys on strangers' disks. Mitigated by fail-safe-not-fail-open, and by the fact that a stopped pipeline is visible in telemetry.
2. **Gmail OAuth still uses a web client with a `localhost:3001` redirect and a client secret on disk.** Correct for a pilot on Ben's consent screen with named test users. **Must move to an installed-app client + PKCE loopback before distribution to anyone unknown.** Phase 2.
3. **No code signing → SmartScreen will warn on first run.** The brainstorm's assumption that users tolerate this (Quantifier's 15–40% abandonment Fermi estimate) remains **unverified**. Known testers on a screen-share aren't a fair test of it. Phase 2 must measure it properly.
4. **Render free-tier cold starts** add tens of seconds to the first call after idle. Slow, not unsafe (§8).
5. **Sandbox-only QBO.** The pilot installs a product that cannot write to a real QuickBooks company (`src/config.ts:104`, guarantee 3). Fine for measuring liveness; it is not a product test.
6. **The pilot cannot resolve the long-tail Postgres corruption risk.** See Risks below.

**Open Questions (0):**
- ~~Broker hosting platform.~~ **RESOLVED** (owner, 2026-07-17): **Render** for the pilot, explicitly as the initial host and not a permanent dependency. The `BrokerClient` seam, `render.yaml`-from-config deploy, standard-SQL portable schema, and https-`BROKER_BASE_URL` config keep the broker movable to another host without reinstalling any AP-Hub client (`ARCHITECTURE-ap-hub-platform.md#7`).

**Additional platform limitations (from the owner's direction, accepted for 1A):**
7. **macOS is compiled, not exercised, in 1A.** The `HostAdapter` macOS impl type-checks but runs on a real Mac only in Phase 1B. Risk: a macOS-only runtime issue (TCC prompts, LaunchAgent quirks) surfaces later. Accepted to keep the pilot to one measured OS first.
8. **QBD/Xero/Sage are interface stubs in 1A.** Only the contract shape is proven (by QBO). Each real adapter is a later phase with its own test target. Risk: an adapter reveals the canonical model needs widening — mitigated because the model is JSONB-backed and the capability matrix already anticipates the known deltas (`provider-research-2026-07-17.md#D`).
9. **QBD from macOS is impossible via any official mechanism** (`provider-research-2026-07-17.md#A.2`). Mac users reach QBD only through a Windows-hosted bridge (Phase 1C). Stated as a hard limitation, not worked around.
10. **Sage Intacct sandbox is gated** (developer license + partner program) — Phase 1B may be blocked on obtaining a test company. Xero (free Demo) is sequenced first.

**Phase plan (full detail in `ARCHITECTURE-ap-hub-platform.md#11`):**
- **Phase 1B** — macOS host adapter exercised; Xero + Sage Intacct connectors (test orgs); shared provider-contract tests; folder-discovery implementation.
- **Phase 1C** — Windows QuickBooks Desktop bridge (qbXML via Web Connector) against a disposable company; authoritative read-back; kill switch; concurrency/failure tests. Production writes still disabled.
- **Phase 2** (`SPEC-final-installer.md`, written AFTER this pilot reports) — desktop-shell decision (Electron / tray+browser); signed Windows installer; signed+notarized macOS package; auto-update + rollback; production onboarding; **production accounting writes** (each provider, separately, the largest and most dangerous work).

## Risks

1. **[HIGHEST] The broker fails open on proof checks and breaks guarantee 5.** A proxy in front of a proof service is exactly where a "helpful" default, a cached response, or a swallowed error turns a hold into a silent pass. Nothing else in this spec can cause financial harm this quietly. Mitigation: the pass-through rule (§4) is absolute; four dedicated outage tests (§10) including the malformed-200 case; existing `proof_fail_safe` tests must pass **unmodified** — if an agent edits one to accommodate the broker, that is a stop-and-escalate event, not a fix.
2. **Install token leaks from a tester's disk.** Mitigation by design: per-install tokens, `revoke --all` kill switch, $5/install/week hard cap enforced before any upstream call. Worst case is bounded and revocable — which is the entire reason the broker exists.
3. **Business data leaks into telemetry.** A well-meaning agent adding a vendor name to a `detail` field for debugging would quietly move financial data off-premises. Mitigation: closed `event` enum (CHECK), 200-char cap, and a content assertion test (§10).
4. **Portable Postgres won't `initdb` on a real tester machine** (antivirus, Controlled Folder Access, corporate policy). This is a live possibility, and it's *the pilot's job to find it* — Archaeologist's point that the pilot's real value is install-time compatibility. Mitigation: explicit `pg_isready` check with a plain-English Defender-exclusion message; fail loudly, never silently.
5. **[UNRESOLVED — carried forward, do not let this disappear] Long-tail local-Postgres corruption.** Archaeologist's dissent (probability 50) held firm through cross-examination: bundling a local DB for non-technical users is structurally the bet QuickBooks Desktop made, and Intuit walked away from it in 2024. **No pilot in this spec can confirm or rule this out** — it surfaces over months across hundreds of machines. It is not solved by this spec, is not solvable by this spec, and must stay on the risk register through Phase 2 and past launch. Escalation path if it materializes: DarkMirror's cloud-relay pivot (§17), not more supervision patched onto the local model.
6. **Agents "fixing" a failing test instead of the code.** The must-not-break list is guarantee-bearing. Mitigation: §10 requires zero edits to existing tests; the Execution Contract makes this a stop-and-escalate.
7. **Scope creep into Electron / macOS execution / other providers / production writes / folder scanning.** The whole reason for the phase gates. Mitigation: `### Do Not Build` pre-loaded into ralph's guardrails; the Execution Contract's "never build ahead of the phase gate" line.
8. **The narrow pilot rots into a Windows/QBO monolith** — provider- or OS-specific code creeps into core, and the "provider-neutral platform" becomes fiction. This is the specific way the owner's direction gets quietly defeated. Mitigation: `lint:noleak` (must stay green in CI-equivalent local gate) + the `AccountingConnector`/`HostAdapter` contract suites + guarantee 8 in the must-not-break list.
9. **Silent capability loss across providers.** A connector dropping an unsupported field quietly corrupts books. Mitigation: `Unsupported` responses + the capability matrix + a contract test asserting no silent drop.
10. **[UNRESOLVED — now MORE relevant] Local-Postgres long-tail corruption AND QuickBooks Desktop `.QBW` risk.** QBD is now explicitly in the product, so Archaeologist's dissent gains a second front. Mitigation is isolation, not removal: the QBD bridge (Phase 1C) reaches the company file **only** through supported qbXML/Web Connector calls and can never touch the `.QBW` directly (safe by construction); local Postgres corruption stays a monitored post-launch risk with the pilot's `pg_health` metric as early signal. Escalation unchanged: cloud-relay pivot if it materializes.

## 15. Glossary

- **Broker** — the new Render service holding Ben's Anthropic + SwarmSync keys and proxying calls. Not a message broker; not a queue.
- **Install token** (`aph_…`) — a per-machine bearer credential for the broker. Not a user login; there are no user accounts.
- **Harness** — the PowerShell + Task Scheduler plumbing that installs, starts, supervises, and reports. Not an installer in the MSI/EXE sense.
- **Supervisor** — `start-aphub.ps1`. Watches the three child processes. Not a Windows Service.
- **Watchdog** — the Task Scheduler task that watches the *supervisor*. The thing that survives the supervisor dying.
- **Fail-safe vs fail-open** — fail-safe: on error, HOLD (nothing posts). Fail-open: on error, proceed. Guarantee 5 requires fail-safe. This distinction is the spec's central safety idea.
- **Direct mode / broker mode** — direct: ap-hub uses local `ANTHROPIC_API_KEY` (Ben's dev box, existing tests). Broker: keys live only on the broker (every pilot install). Chosen by config.
- **Crux** — the brainstorm's term for the one measurable claim that flips the recommendation: do PCs stay on, and does local Postgres survive sleep/wake/reboot.

## 16. Monitoring & Metrics

What actually exists — no Grafana, no PagerDuty, no on-call.

| Signal | Mechanism | Threshold / action |
|---|---|---|
| Broker liveness | Render's built-in health check → `GET /health` | Render restarts on failure; Render emails Ben on repeated failure |
| Broker errors | Render logs (Pino JSON, `LOG_LEVEL=info`) | Read on demand; no alerting infrastructure for a 5-install pilot |
| **Install silent death** | `installs.last_seen_at` older than **15 min** during the tester's business hours | `pilot-report` flags it. This is the metric DarkMirror's whole argument demanded — a dead process writes no exception row, so only an *external* observer can see it. |
| Spend | `spend_ledger` week-to-date vs `weekly_cap_usd` | Enforced in code at 100% (429). `list-installs` shows it. |
| **Success metric query** | `pilot-report --days 7` | Emits the three numbers |

The success-metric query, concretely:
```sql
-- (a) online-hours %: minutes with an 'alive' heartbeat ÷ business minutes in range
-- (b) watchdog recovery rate: watchdog_restart events followed by an 'alive' within 5 min ÷ all restarts
-- (c) corruption incidents: count of pg_health rows with pg_ok = false
```
Business hours default to **Mon–Fri 08:00–18:00 in the install's local timezone** (from `tz_offset_minutes`), configurable via `--business-hours`. Stating the definition matters: "online-hours %" is meaningless without it, and Quantifier's dissent was precisely that this number was being asserted without ever being defined.

## 17. Alternative Designs Considered

1. **Bake Ben's API keys into the pilot build.** Rejected: any tester can extract them and spend without limit against Ben's Anthropic account, and there's no revocation short of rotating the key on every install. Acceptable *only* for a pilot among people Ben trusts absolutely — and the owner chose the broker precisely because it's needed before distribution regardless, so building it now means the pilot tests the real architecture (including broker round-trip latency) instead of a throwaway one.
2. **Each tester supplies their own Anthropic + SwarmSync keys.** Rejected: requires a non-technical bookkeeper to create an Anthropic account, add a payment card, and generate an API key. Contradicts the target user; would likely fail at step one of onboarding.
3. **DarkMirror's full cloud relay** — move the whole pipeline (Gmail poll → SwarmSync → QBO) server-side; desktop becomes a thin client. Rejected for now by DarkMirror's own Phase 4 verdict: an irreversible, un-piloted pivot that puts tenant financial data off-premises and adds hosting/security/compliance burden on a solo operator. **Held as the escalation path** if Risk 5 materializes. Note this spec's broker is deliberately *not* a step toward it — it brokers keys only, never business data (§2), so it does not quietly become a relay by accretion.
4. **A real Windows Service instead of Task Scheduler.** Rejected per the brainstorm's convergence: a non-elevated Task Scheduler restart-on-failure/logon trigger closes the silent-death gap without service-account or elevation complexity, and an admin-rights install is a real adoption tax on a non-technical user. Revisit only if the pilot shows Task Scheduler recovery is unreliable.
5. **Ship Electron now, pilot later.** Rejected: this is what the brainstorm explicitly argued against ("run the pilot before writing the final installer spec"), and the Electron-vs-tray-plus-browser question has a live 40%-probability dissent that a user-perception test — not a build — resolves.

## 18. Build Phases & Final Checklist

### Build Phases

**Phase 0 — Baseline (blocking; ~0.5 day).** Start Postgres. Run `npm test`, `npm run lint`, `npm run typecheck`, `npm run web:build`. **Record the true passing test count** — resolves 212 vs 189. Fix `.env.example` port drift (lines 12, 21, 29: 3000 → 3001). Verify: all four commands green; baseline count written into `.ralph/state.md`.

**Phase 1 — Broker skeleton + auth (~3 days).** `broker/` scaffold (`node:http`, Zod config, Pino). Migrations `001_init` UP/DOWN + verification query. Token issue/revoke/list CLI. Bearer auth middleware, constant-time compare, SHA-256 storage. `/health`. Verify: auth matrix test (401/401/403/200) green; UP→DOWN→UP clean on a scratch DB.

**Phase 2 — Broker proxy routes + caps (~3 days).** `/v1/extract` → Anthropic; `/api/verify`, `/api/scan/invoices`, `/api/proof/:id/export/verify` → SwarmSync (paths mirrored exactly). Spend ledger + weekly cap; rate limit. **Pass-through fidelity + fail-closed enforcement.** Verify: cap test asserts upstream mock called **0 times** at cap; upstream non-2xx never becomes 2xx; DB-down → 503 with no upstream call.

**Phase 3 — ap-hub rewiring / broker mode (~2 days).** Config: `BROKER_BASE_URL` (https-validated), `BROKER_INSTALL_TOKEN`; `ANTHROPIC_API_KEY`/`SWARMSYNC_API_KEY` optional. `src/broker/BrokerClient`. `getBrokerExtractor()` implementing `Extractor`. `src/pipeline/extract.ts:214` mode select. `src/services.ts` broker-mode `SwarmSyncClient`. Logger redaction for `aph_` + bank patterns. Verify: **`test/broker-fail-safe.test.ts` — all four outage cases hold, none fail open**; full suite ≥ Phase-0 baseline with **zero existing tests edited**; boot succeeds with no `ANTHROPIC_API_KEY` present.

**Phase 4 — Provider-neutral connector seam + canonical model (~4 days).** `src/canonical/` model types (dimensions as extensible list) + mapping helpers onto existing `proposals.proposed_txn`/`mappings`. `src/connectors/` `AccountingConnector` + `CapabilityMatrix` + `Unsupported`. **QBO reference adapter wrapping existing `src/qbo/` (delegation only, zero logic change to `write.ts`).** QBD/Xero/Sage capability-declaring stubs that throw `NotImplementedInPhase`. Reusable connector contract-test suite. Additive migration: generalize `postings.qbo_*` behind a back-compat VIEW; add `connections` table; widen `Provider` enum. `lint:noleak` rule. Verify: QBO adapter passes the contract suite; **`test/posting.test.ts` passes unmodified** (behavior identical through the interface); `Unsupported` surfaced not dropped; `lint:noleak` green; migration UP→DOWN→UP clean; full suite ≥ baseline, zero existing tests edited.

**Phase 5 — Telemetry (~2 days).** `/v1/heartbeat` + enum/length validation + content-assertion test. `pilot-report` CLI with the three queries + business-hours definition. Verify: content-assertion test green (business data never stored); `pilot-report` prints three numbers + sample size + date range against seeded data.

**Phase 6 — Cross-platform host adapter + Windows harness (~4 days).** `src/host/` `HostAdapter` + `SecretStore` interfaces + contract-test suite. **Windows adapter** (DPAPI, Task Scheduler, `%LOCALAPPDATA%`, port probe). **macOS adapter** (Keychain, LaunchAgent, `~/Library/...`) — implemented + type-checked, **not exercised** (Phase 1B). `install-pilot.ps1` (consent screen, portable Node + Postgres 16, `initdb`, migrations, `.env` gen, port probes, disk check, watchdog registration — driven through the Windows `HostAdapter`). `start-aphub.ps1`/supervisor (three-process supervision, lock file, 60s heartbeat, restart-on-death). `aphub-watchdog.xml`. `uninstall-pilot.ps1` (**preserves data by default; separate explicit confirm to delete all**). Verify: `HostAdapter` contract suite green on Windows; `typecheck` green with macOS adapter present; **manual on a non-dev Windows machine** — non-admin install no UAC, kill-backend → ≤90 s restart, kill-supervisor → ≤5 min recovery, reboot → three alive ≤3 min, sleep/wake → `pg_isready` 0, key grep zero.

**Phase 7 — Deploy + one-machine rollout (~0.5 day).** Render blueprint deploy; env vars in the dashboard (never git). Live `/health` 200. Issue one token, install on one real machine, confirm heartbeats land. Run 48 h before touching other testers. Verify: every §3 acceptance criterion observed live, with its artifact.

### Final Checklist
- [ ] Phase 0 baseline recorded; `.env.example` port drift fixed
- [ ] Broker: auth matrix, spend cap (upstream not called), rate limit, pass-through fidelity, fail-closed
- [ ] Broker: migrations UP/DOWN/UP clean; verification query returns 3
- [ ] ap-hub: boots with no `ANTHROPIC_API_KEY`; broker-mode extraction works end-to-end
- [ ] **All four broker-outage cases HOLD — zero fail-open**
- [ ] **QBO reference adapter passes the `AccountingConnector` contract suite; `test/posting.test.ts` unmodified**
- [ ] **`lint:noleak` green — no provider/OS symbol leaks into core; `typecheck` green with macOS adapter present**
- [ ] Canonical-model migration additive (back-compat VIEW); `Provider` enum widened; existing tests pass
- [ ] Existing suite ≥ Phase-0 baseline; **zero existing tests modified**
- [ ] `npm run lint && npm run lint:noleak && npm run typecheck && npm test && npm run web:build` all green
- [ ] Telemetry stores no business data (content assertion green)
- [ ] `HostAdapter` contract suite green on Windows; harness installs non-admin with no UAC; watchdog recovers backend + supervisor kills
- [ ] Uninstall preserves data by default; delete-all requires separate explicit confirmation
- [ ] Broker live on HTTPS; `/health` 200; keys only in Render env
- [ ] `grep` for `sk-ant` / `ssk_live` on the pilot machine returns zero
- [ ] `pilot-report` emits the three numbers from real heartbeats
- [ ] Kill switch (`revoke --all`) tested and works

### AI Agent Execution Contract

```
The building agent must:
- [ ] Read the full spec + Architecture Grounding Summary before writing code
- [ ] Produce a plan/file-tree first — not code
- [ ] Test every "must not break" item before marking any phase complete
- [ ] Treat the Definition of Done as the ONLY completion signal
- [ ] Stop and escalate if a must-not-break guarantee is at risk — never ship around it
- [ ] Attach a concrete artifact per done condition (test output, HTTP log, DB row)
- [ ] Never mark done on local-only verification — deployed-environment proof required
```

**Additional non-negotiables for this build:**
- **Never edit an existing test to make it pass.** The six guarantees are enforced by those tests. If one fails, the code is wrong — stop and escalate. (Applies equally to any connector, host adapter, or broker change.)
- **Never let the broker return 2xx when upstream failed.** No cached proofs, no default-pass, no "graceful degradation" on a proof call. Fail-safe means HOLD.
- **Never modify `src/qbo/write.ts` logic.** The connector wraps it; it does not change it. Guarantees 1 and 3 live there.
- **Never let a provider- or OS-specific symbol into core.** `lint:noleak` must stay green — that rule is what keeps this narrow pilot from rotting into a Windows/QBO monolith. Connector code lives in `src/connectors/**`, host code in `src/host/**`.
- **Never silently drop an unsupported accounting field.** Return `Unsupported`, surface it, audit it.
- **Never enable a production accounting write for any provider.** Sandbox/test/disposable only, all of 1A–1C.
- **Never add business data to a heartbeat.** Liveness only.
- **Never request elevation.** If something seems to need admin, stop and escalate.
- **Never commit a key.** Broker keys live in Render env vars only.
- **Never build ahead of the phase gate.** No macOS execution, no QBD/Xero/Sage adapter logic, no folder scanning, no Electron in Phase 1A — those are stubs/interfaces only. If a phase seems to need one, stop and escalate.
