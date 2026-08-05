# Architecture Cartographer Report — AP-Hub Accounting-Provider Subsystem
**Audited:** 2026-07-28 · **Mode:** QUICK MAP (scoped to the accounting-provider/connector architecture, per user focus) · **Purpose:** ground a real Xero connector spec in actual integration points, not assumptions

## Executive Summary

AP-Hub already has a clean, provider-neutral `AccountingConnector` contract (`src/connectors/types.ts`) with a real, working QBO implementation to mirror (`src/connectors/qbo.ts`) — Xero is currently a capability-declaring stub (`src/connectors/stubs.ts`) that throws on every method. The project's own spec was updated 2026-07-25 to pull Xero into Version-1 scope (no longer a deferred phase), and a prior deep-research pass (2026-07-17) already produced a solid Xero capability matrix. The single most important finding: the live posting pipeline (`src/pipeline/posting.ts:456-471`) is **hardcoded to QBO** — building a real Xero connector is necessary but not sufficient; the job handler needs a provider-neutral dispatch step that doesn't exist yet.

## Project Map

### Project Type
Local-first Electron desktop app (Node/TypeScript backend, Next.js renderer) — accounting-document intake and posting automation. See root `CLAUDE.md`.

### Relevant Modules (accounting-provider subsystem)
| Module | Path | Purpose |
|---|---|---|
| Connector contract | `src/connectors/types.ts` | Provider-neutral `AccountingConnector` interface, `CapabilityMatrix`, `ProviderId` enum |
| QBO real connector | `src/connectors/qbo.ts` | Reference implementation — wraps `src/qbo/write.ts` + `src/qbo/client.ts`, translates canonical↔QBO |
| Xero/Sage/QBD stubs | `src/connectors/stubs.ts` | Capability-declaring only; every method throws `NotImplementedInPhase` |
| Connector factory | `src/connectors/factory.ts` | `getQboConnector(tenantId)` — the ONLY factory function that exists; no Xero/generic equivalent |
| Canonical model | `src/canonical/model.ts` | Provider-neutral `CanonicalBill`/`CanonicalVendor`/`CanonicalAccount`/`CanonicalDimension` |
| Connect flow (OAuth) | `src/auth/connect-loopback.ts`, `connect-urls.ts`, `connect-state.ts` | Desktop loopback + web OAuth "start" flows — Gmail/QBO today, generalized enough for a 3rd provider |
| Provider host allowlist | `desktop/channels.ts:54-63` | `PROVIDER_HOSTS` already includes `login.xero.com` and `www.intacct.com` |
| Live posting job | `src/pipeline/posting.ts:456-471` | `postSandboxHandler` — hardcoded to `getQboConnector`, QBO-specific env gate |
| Contract test suite | `test/connector-contract.test.ts` | Reusable `runConnectorContract()` every real connector must pass; currently only exercised for QBO |
| Config | `src/config.ts` | `QBO_*` env var family (11 vars) to mirror for `XERO_*` |
| Token storage | `src/auth/tokens.ts:15` | `Provider` type already includes `'xero'` |

### Important Config
| File | Controls |
|---|---|
| `src/config.ts:56-70` | QBO env vars (client id/secret, realm, redirect URI, sandbox vs production, write-enable gate) — pattern to mirror |
| `.env.example` | Template; currently no `XERO_*` entries |
| `specs/reference/provider-research-2026-07-17.md` | Pre-existing sourced research backing the capability matrices below |
| `specs/reference/ARCHITECTURE-ap-hub-platform.md` | Durable architecture doc (2026-07-17) — **partially superseded**, see Concern #2 |
| `docs/decisions/windows-only-v1-2026-07-25.md` | AUTHORITATIVE scope decision — supersedes the architecture doc's cross-platform staging |
| `specs/SPEC-local-desktop-shell.md:98-108` | "SCOPE EXPANSION — 2026-07-25": Xero pulled from deferred-phase into V1 scope, must not remain a silent/indefinite stub |

### Test Surface
| Type | File | Notes |
|---|---|---|
| Contract suite | `test/connector-contract.test.ts` (156 lines) | `runConnectorContract(name, makeConnector, expectedCompany)` — reusable; only run for `qbo` today; separately asserts stubs throw (lines 143-145+) |
| Capability matrix | `test/provider-capabilities.test.ts` (160 lines) | "Executable matrix" + tenant API service tests |

## System Understanding

**What exists today (evidence-grounded):**
1. A real, tested QBO connector (`src/connectors/qbo.ts`) implementing the full `AccountingConnector` interface: capability declaration, company-identity verification, vendor/account read, bill create with dimension translation, duplicate detection, posting, attachment, and read-back verification with mismatch detection (amount/docnumber/dimension).
2. A capability-declaring-only Xero stub (`src/connectors/stubs.ts:65-79`) — its `CapabilityMatrix` is already correctly researched (`read: ['vendor','account','bill']`, `dimensions: ['tracking_category']` with the "max 2 active per org" comment, `multiCurrency: true`, `idempotency: 'native'`) but every method throws.
3. A prior architecture pass (2026-07-17) already designed the provider-neutral contract this exact interface implements, and separately deep-researched all 4 target providers (`provider-research-2026-07-17.md`) — this pre-existing research is consistent with the fresh deep-research from this session (both confirm: PKCE OAuth, 60/min+5000/day rate limits, `Idempotency-Key` header, ≤2 tracking categories, Bills = Invoices with `Type=ACCPAY`).
4. The connect/OAuth flow (`connect-loopback.ts`) is provider-parameterized (`ConnectProvider = 'gmail' | 'qbo'` today) but not yet widened to include `'xero'`.

**Production-critical dependency:** every accounting write flows through `postOnce()` in `posting.ts`, which receives an already-constructed `connector: AccountingConnector` — the guarantees (no-double-post, proof-gating, read-back verification) are enforced generically against the interface, NOT per-provider. This means a correctly-implemented Xero connector inherits all existing safety guarantees for free — it does not need to reimplement dedup/proof-gating logic, only correctly implement `detectExisting`/`postBill`/`readBackVerify` per Xero's actual API shape.

## Architecture Map

### External Integrations (accounting providers)
| Provider | Package/Client | Env Var Family | Import Location | Status |
|---|---|---|---|---|
| QBO | `src/qbo/client.ts`, `src/qbo/write.ts` | `QBO_*` (11 vars, `src/config.ts:56-70`) | `src/connectors/qbo.ts`, `src/connectors/factory.ts` | Active, real |
| Xero | none yet | none yet | `src/connectors/stubs.ts` only | **Stub** |
| Sage Intacct | none yet | none yet | `src/connectors/stubs.ts` only | **Stub** (out of scope for this spec) |
| QBD | `src/connectors/qbd.ts` (also a stub per `stubs.ts:97`) | none yet | — | **Stub**, separate connection class (`local_desktop`) |

### Internal Services (connector-adjacent)
| Service | File | Purpose | Called By |
|---|---|---|---|
| Connector factory | `src/connectors/factory.ts` | Builds a live, config-wired connector for a tenant | `posting.ts:460` (QBO only) |
| Connect-start (OAuth) | `src/services/action/connections.ts` | Opens system browser to provider consent, runs loopback callback | `desktop/ipc/action/connections.ts` (IPC), `app/api/connections/*` (web) |
| Live posting job | `src/pipeline/posting.ts:456` `postSandboxHandler` | pg-boss job handler; the sole entry point that calls a connector's `postBill` | `src/pipeline/register.ts` |

## Top 5 Concerns (evidence-cited, for the spec to address)

### 1. `posting.ts` is hardcoded to QBO — building `xero.ts` alone is not sufficient
**Evidence:** `src/pipeline/posting.ts:460` — `const { getQboConnector } = await import('../connectors/factory.js');` and `:464` — `if (cfg.QBO_ENV === 'production') throw ...` (a QBO-specific gate living directly in the pipeline job handler, not behind the connector interface).
**Why this matters:** even a perfect `createXeroConnector()` real implementation is unreachable from the live posting path until `postSandboxHandler` (and its production-write gate) is generalized to route by the tenant's actual connected provider. This is a required spec task, not an implementation detail to discover mid-build.
**Suggested verdict:** Refactor. Add a `getConnectorForProvider(tenantId): Promise<AccountingConnector>` dispatcher in `factory.ts` that reads the tenant's active `connections` row to decide QBO vs Xero, and generalize the production-write gate to be per-provider (mirroring `QBO_PRODUCTION_WRITE_ENABLED` → `XERO_PRODUCTION_WRITE_ENABLED`).

### 2. The 2026-07-17 architecture doc is partially superseded — the spec must not inherit its stale parts
**Evidence:** `ARCHITECTURE-ap-hub-platform.md` places Xero in "Phase 1B — Cross-platform + cloud expansion" (§11) alongside a Render-hosted key broker (§7) and macOS parity work. `docs/decisions/windows-only-v1-2026-07-25.md` (AUTHORITATIVE, dated 8 days later) states plainly: *"Where any other document still implies macOS is required for Version 1, this document wins."* `specs/SPEC-local-desktop-shell.md:98-108` separately confirms Xero was pulled OUT of the deferred-phase framing into current V1 scope, and that the hosted key broker is explicitly a "Do Not Build" item now (`SPEC-local-desktop-shell.md:88`, "Removal of the hosted key broker").
**Why this matters:** the architecture doc's excellent `AccountingConnector`/`CapabilityMatrix` design (§4) and its provider capability matrix (§4, cross-checked against `provider-research-2026-07-17.md`) are still directly usable — but its phase placement, broker references, and cross-platform staging for Xero are not. A spec written by copying the architecture doc's Phase 1B framing verbatim would misrepresent current scope.
**Suggested verdict:** Document. The new spec must explicitly cite which parts of the architecture doc it's drawing from (capability matrix, contract shape) vs. explicitly overriding (phase, broker, macOS staging).

### 3. The real `AccountingConnector` interface already diverged from the architecture doc's draft
**Evidence:** Architecture doc §4 proposes `connect(cfg): Promise<ConnectHandle>` and `close(handle: ConnectHandle)`. The actual, currently-compiling `src/connectors/types.ts:80-117` has no `connect()` method at all, and `close(): Promise<void>` takes no argument — connection setup happens entirely in `factory.ts`, not on the interface.
**Why this matters:** per CLAUDE.md's own rule ("the code wins"), the spec must be written against `src/connectors/types.ts` as it exists today, not the architecture doc's proposed shape.
**Suggested verdict:** Document (already handled correctly by treating types.ts as ground truth in this map).

### 4. `PROVIDER_HOSTS` comment is stale but the allowlist itself is already correct
**Evidence:** `desktop/channels.ts:54-56` comment says *"their connectors are P4 capability-declaring stubs that throw today, so no code path reaches those hosts yet"* — but `login.xero.com` is already present in the frozen `PROVIDER_HOSTS` array (`:61`), and per Concern #2, Xero is no longer P4. The allowlist mechanism needs zero code change; only the comment is wrong.
**Why this matters:** low-risk, but the spec should note this as a one-line doc fix so a future reader isn't misled about why the host is present.
**Suggested verdict:** Document (trivial fix, not a blocking task).

### 5. Contract test suite is ready to receive Xero, but currently asserts the opposite
**Evidence:** `test/connector-contract.test.ts:143-145` has a `describe('provider stubs are capability-declaring but throw NotImplementedInPhase', ...)` block that explicitly tests `['xero', createXeroConnector]` throws on every call. `runConnectorContract()` (`:46-91`) is the exact reusable suite a real Xero implementation needs to pass, already proven correct against QBO with a mocked write/read client pattern (`mockWrite`/`mockRead`, `:9-30`) directly reusable for a `mockXeroWrite`/`mockXeroRead` equivalent.
**Why this matters:** implementing `xero.ts` for real requires a coordinated test change — moving Xero out of the "stub throws" block and into `runConnectorContract('xero', ...)` in the same PR, or the test suite will fail (correctly) the moment `createXeroConnector` stops throwing.
**Suggested verdict:** Refactor (test), paired with the connector implementation — not a separate task.

## Validation Checklist
- [x] Structure mapped from actual file tree (Glob/Bash `find`, not assumed)
- [x] Connector contract, QBO reference impl, and Xero stub read in full
- [x] Env var pattern (QBO_*) traced to `src/config.ts` usage
- [x] Xero references searched repo-wide (7 files found, all read/grepped)
- [x] Pipeline/posting.ts connector usage traced (found hardcoding — Concern #1)
- [x] Existing architecture doc + spec + decision-record cross-checked against current code for staleness
- [x] Contract test suite read to determine exact pass/fail requirements for a new provider
- [ ] `desktop/ipc/action/connections.ts` full read — **[BLOCKED: not needed]** grep confirmed it contains no connector-specific logic (OAuth start flow only, separate from accounting-data connector); full read would not change any finding

## Open Questions / Decisions Needed
1. **Provider dispatch strategy for `postSandboxHandler`** (Concern #1) — resolve by reading the tenant's `connections` table for the active cloud-provider row (mirrors how `getQboConnector` already looks up its own connection), or should provider be threaded through the job payload at enqueue time? Both are reasonable; the spec should pick one with reasoning.
2. **Xero production-write gate naming/shape** — mirror `QBO_PRODUCTION_WRITE_ENABLED` exactly, or design a provider-generic gate now that a 2nd cloud provider exists? Recommend mirroring for consistency unless the spec author sees a reason not to (YAGNI cuts toward mirroring).

---
**Changed:** This report created at `docs/audits/architecture-map-2026-07-28.md`. Nothing else touched.
**Verified:** All file paths cited were read or grepped this session; `login.xero.com` presence in `PROVIDER_HOSTS` confirmed directly; `posting.ts` QBO-hardcoding confirmed by line-level read.
**Still Broken:** Nothing — this is a map, not a fix. Concerns #1 and #5 are real spec-scope items, not defects to fix here.
