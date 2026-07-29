# CHUNK_10_XERO_CONNECTOR: Bring the provider-neutral AccountingConnector contract to life for Xero.

**Status:** Ready for Build. All three open questions resolved by the owner on 2026-07-28 (see
Open Questions — Resolved).

## Summary

`src/connectors/xero.ts` does not exist yet. Xero is currently a capability-declaring stub
(`src/connectors/stubs.ts:65-79`) — its `CapabilityMatrix` is real and already correctly
researched, but every method throws `NotImplementedInPhase`. The 2026-07-25 scope decision
(`specs/SPEC-local-desktop-shell.md:98-108`) pulled Xero out of its original deferred phase and
into Windows Version 1: *"They must not remain silent or indefinite stubs; where live credentials
are absent, everything up to the real connection boundary ships and only the external proof is
marked awaiting credentials."* This chunk is that build.

It comes after CHUNK_5_CONNECT (the loopback OAuth pattern this chunk widens to a third provider)
and reuses the QBO connector (`src/connectors/qbo.ts`) as its structural reference — same
delegation pattern, same `AccountingConnector` interface, same fail-closed read-back guarantee,
translated to Xero's actual API shape. It hands the next chunk (packaging/certification) a second
live cloud provider to certify, and generalizes the live posting job off its current QBO-only
hardcoding — a prerequisite this chunk discovered, not an unrelated cleanup: `src/pipeline/
posting.ts:456-471` imports `getQboConnector` directly, so a correct `xero.ts` is unreachable from
production without this chunk also adding a provider-neutral dispatcher.

Grounded in: `docs/audits/architecture-map-2026-07-28.md` (this chunk's own architecture map),
`specs/reference/provider-research-2026-07-17.md` §B (Xero, CONFIRMED against official docs), and
a fresh deep-research pass run 2026-07-28 that corroborated it and added: `xero-node` is the
correct SDK (not the official Xero MCP server, which is built for AI-assistant tool-calling, not
backend integration); new granular OAuth scopes are mandatory for AP-Hub as a new app; and Xero's
Dec-2025 pricing policy caps the free tier at 5 connections **per registered app**, which is the
basis for Open Question 1 below.

## Acceptance Criteria

- [ ] `src/connectors/xero.ts` exports `createXeroConnector()` implementing the full `AccountingConnector` interface (`src/connectors/types.ts`) for real — no `NotImplementedInPhase` anywhere in the live path. It replaces (not wraps) the stub currently exported from `src/connectors/stubs.ts`; `src/connectors/index.ts` and `factory.ts` are updated to point at it.
- [ ] Built on the official `xero-node` SDK (npm, actively maintained by the Xero Developer team) — never the Xero MCP server, which is designed for LLM tool-calling clients, not a deterministic backend pipeline.
- [ ] OAuth uses the **PKCE flow against a "Desktop app"-type Xero OAuth client** (never "Web application" type — a Web-application client rejects AP-Hub's dynamic `http://127.0.0.1:<port>/callback` loopback redirect with `redirect_uri_mismatch`). New `XERO_CLIENT_ID` config var (no `XERO_CLIENT_SECRET` — PKCE desktop clients hold no secret), mirroring the `GMAIL_CLIENT_ID` pattern in `src/config.ts`.
- [ ] Authorization requests use only the new **granular OAuth scopes** (`accounting.contacts`, `accounting.settings`, `accounting.attachments`, `accounting.invoices`, `offline_access`, plus any further scope a capability in this chunk genuinely needs) — never the old broad `accounting.transactions` scope, which is unavailable to apps created after 2026-03-02.
- [ ] `src/auth/connect-loopback.ts`'s `ConnectProvider` type widens from `'gmail' | 'qbo'` to include `'xero'`; the existing loopback flow (state, PKCE challenge, 10-minute expiry, single-use listener) is reused unmodified — this chunk adds a provider, it does not touch the flow's mechanics.
- [ ] Every write (`create`, `postBill`) sends a UUID `Idempotency-Key` header. **Test:** the exact same create request sent twice (simulating a network retry) results in exactly one Xero Invoice, proven against a real Xero Demo Company, not just asserted from documentation.
- [ ] `capabilities().read` includes `vendor` and `account`; vendor read/create uses Xero **Contacts** and never attempts to set `IsSupplier` — it is read-only/derived by Xero after a posted ACCPAY document. **Test:** creating a vendor contact and immediately reading it back never throws or silently coerces a value into a read-only field.
- [ ] `capabilities().dimensions` reports Xero's real ceiling: **max 2 active Tracking Categories, applied at line level.** A canonical dimension beyond that (or beyond what's configured) surfaces as `Unsupported` (per `src/canonical/model.ts`'s `Unsupported` type) — audited via the existing `onUnsupported` hook, exactly like `qbo.ts:146-173`'s `gapsFor`. **Test:** a bill with 3 dimension kinds posts with 2 applied and 1 explicitly reported as `Unsupported` — never silently dropped, never a hard failure.
- [ ] Every `create`/`postBill` is followed by an authoritative `readBack`/`readBackVerify` against Xero's own response before anything is marked posted, using `UpdatedDateUTC` as the `revision` token (the `ExternalRef.revision` field). A malformed, partial, or missing read-back is treated as failure → hold — never marked posted. This is the existing fail-closed guarantee (`ARCHITECTURE-ap-hub-platform.md:162`), generalized to a second provider, not a new rule.
- [ ] `verifyCompanyIdentity` confirms the connected Xero organisation's name matches the configured expected company **before** any `create` is permitted — mirrors `qbo.ts:199-203`'s realm check.
- [ ] Xero writes to a live (non-Demo) organisation are disabled by default. A new `XERO_PRODUCTION_WRITE_ENABLED` gate (mirroring `QBO_PRODUCTION_WRITE_ENABLED` in `src/config.ts:58`) must be explicitly `true`, plus an exact configured Xero tenant-id + company-name binding, before any write reaches a real customer organisation — same shape as the existing QBO production gate, never weaker.
- [ ] A `429` response is retried with backoff honoring the `Retry-After` header. Xero's limits (60/min + 5,000/day per tenant, 10,000/min app-wide, 5 concurrent) are not expected to bind for a single-company-per-install traffic pattern, but the retry path must exist and be tested, not assumed unnecessary.
- [ ] The source document (PDF/image) is uploaded to the created Invoice via `POST /Invoices/{id}/Attachments/{filename}` — best-effort, matching the existing `attachDocument` contract shape (`qbo.ts:283-285`).
- [ ] **`src/pipeline/posting.ts`'s job handler no longer hardcodes `getQboConnector`.** A new `getConnectorForProvider(tenantId): Promise<AccountingConnector>` in `src/connectors/factory.ts` looks up the tenant's active cloud `connections` row and returns the correctly-wired connector (QBO or Xero); `postSandboxHandler` calls this instead of importing `getQboConnector` directly, and its QBO-specific production-write gate check generalizes to check the correct provider's gate. **Test:** a tenant connected to Xero (not QBO) posts successfully through the same job handler with zero QBO-specific code executing.
- [ ] No file outside `src/connectors/**` references a Xero-specific identifier (`Invoices`, `ACCPAY`, `TrackingCategory`, `Xero-tenant-id`, `xero-node`, etc.) — verified by the existing `npm run lint:noleak` rule (`ARCHITECTURE-ap-hub-platform.md:275`), which must pass with zero new exceptions carved out for this chunk.
- [ ] `desktop/channels.ts:54-56`'s comment ("their connectors are P4 capability-declaring stubs... no code path reaches those hosts yet") is corrected — `login.xero.com` in `PROVIDER_HOSTS` is now genuinely reachable. The allowlist array itself requires no code change (`login.xero.com` is already present).
- [ ] `test/connector-contract.test.ts`: Xero moves out of the `'provider stubs are capability-declaring but throw NotImplementedInPhase'` block (currently lines 143-145+) and into its own `runConnectorContract('xero', () => createXeroConnector({...mockDeps}), '<expected demo company name>')` call, in the **same PR** as the connector implementation — the existing test would otherwise correctly fail the moment `createXeroConnector` stops throwing.
- [ ] **Where a live Xero test-org connection is not available at build time**, everything up to that boundary ships and is proven with a mocked `xero-node` client (matching the existing `mockWrite`/`mockRead` pattern in `connector-contract.test.ts:9-30`) — the external proof (a real bill posted to a real Xero Demo Company and read back) is explicitly logged as **UNVERIFIED — awaiting Xero test-org credentials**, never silently claimed done. This is the 2026-07-25 scope decision's own instruction, not a new allowance invented here.
- [ ] All tests pass with zero failures (`npm run verify` exits 0), with no existing safety test (`lockdown`, `gatekeeper`, `posting`, `anchor-whitelabel`, `architecture-connector-path`) modified.

## Endpoints / Interfaces

No new IPC channel. The existing connect-flow channel widens its accepted `provider` value:

| Channel | Auth | Request | Response |
|---|---|---|---|
| `aphub:connections:start` | owner | `{ provider: 'gmail' \| 'qbo' \| 'qbd' \| 'xero' }` | `{ ok: true, state: 'browser_opened' }` |

Errors: `CONNECT_TIMEOUT` \| `PROVIDER_OFFLINE` \| `SECURE_STORE` (all pre-existing, from CHUNK_5).

The `AccountingConnector` interface itself (`src/connectors/types.ts`) is **not** an IPC surface —
it is consumed internally by `src/pipeline/posting.ts` via the new `getConnectorForProvider`
dispatcher in `src/connectors/factory.ts`. No renderer-facing API changes.

## Database Changes

No new tables expected. `src/auth/tokens.ts:15`'s `Provider` type already includes `'xero'`, and
per `ARCHITECTURE-ap-hub-platform.md:212`, cloud OAuth connections (QBO, Xero) reuse the existing
widened `connections`/`oauth_tokens` shape — only QBD (non-OAuth) needed a new table, and that is
out of scope here. **Verify at build time:** confirm the live `connections`/`oauth_tokens` schema
accepts `provider='xero'` without a constraint violation (a one-query check, not expected to
require a migration, but not yet confirmed against the live schema in this spec pass).

## Test Scenarios

- **Happy path**: connect Xero (Demo Company, PKCE Desktop-app client) → a canonical bill with vendor + one line + one dimension is created → connector posts it as an Invoice with `Type=ACCPAY` → `readBackVerify` confirms amount, doc number, and the tracking-category dimension match → the bill is marked posted. `runConnectorContract('xero', ...)` passes with a mocked `xero-node` client; a separately-gated `test/xero-create.int.test.ts`-style integration test (mirroring `test/backup-create.int.test.ts`'s "real, not mocked" pattern) runs the same flow against a real Xero Demo Company when `XERO_CLIENT_ID` + a live connection are present, and is honestly skipped (not faked green) otherwise.
- **Edge case**: retrying the identical create request (same `Idempotency-Key`) produces exactly one Invoice, not two; a bill with 3 dimension kinds posts with 2 applied and the 3rd reported as `Unsupported`; a simulated `429` triggers backoff-and-retry rather than a lost write or a duplicate.
- **Failure case**: `verifyCompanyIdentity` mismatch refuses the post before any write is attempted; a malformed/partial `readBack` (missing `UpdatedDateUTC`, or an amount mismatch) is treated as failure → hold, never marked posted; a write attempted against a production (non-Demo) organisation with `XERO_PRODUCTION_WRITE_ENABLED=false` (the default) is refused before any HTTP call is made.
- **Integration**: `postSandboxHandler` correctly routes a Xero-connected tenant to `createXeroConnector` (not `getQboConnector`) with zero QBO-specific code on that path — the concrete proof that Concern #1 from the architecture map is actually resolved, not just documented as a plan.

## Dependencies

- **Requires**: CHUNK_5_CONNECT (the loopback OAuth pattern this chunk widens to a third provider); the existing `AccountingConnector` contract (`src/connectors/types.ts`) and QBO reference implementation (`src/connectors/qbo.ts`), both already built and unmodified by this chunk except where `factory.ts` gains the new dispatcher.
- **Blocks**: nothing hard-blocks on this chunk in the numbered sequence, but CHUNK_9_PACKAGE's clean-machine certification should re-verify Xero alongside QBO/QBD before Version 1 is called complete, per the 2026-07-25 scope decision pulling Xero into V1. (This spec does not edit CHUNK_9_PACKAGE.md's own Dependencies list — that is the owner's call, noted here for visibility.)

## Open Questions — Resolved (owner decision, 2026-07-28)

1. **Bring-your-own-Xero-app-per-customer, or one shared AP-Hub Xero app? → Per-customer.**
   Each user registers their own Desktop-type PKCE OAuth client in their own Xero Developer
   account (exactly like the Gmail flow), keeping every install on Xero's free Starter tier
   indefinitely regardless of the exact current connection cap. The connect-flow UI must explain
   "create your own Xero app" the same way it will eventually need to for Gmail. The disagreement
   between the two research passes' connection-cap numbers (5 vs. 25) no longer needs resolving
   before build — it's irrelevant once every customer is on their own single-organisation app.
2. **Does a private, never-listed Xero integration need Xero App Store certification? → No.**
   Owner-confirmed: a private, self-authorizing, never-listed integration requires no Xero
   certification or security assessment. Removes the only pre-launch (non-technical) dependency
   this chunk had on an external party.
3. **Provider-dispatch design → the simpler option.** `getConnectorForProvider(tenantId)` reads
   the tenant's `connections` table at job-handler time, mirroring `getQboConnector`'s existing
   lookup exactly — no new job-payload shape, smallest possible diff to `postSandboxHandler`.

## Risks

- **Xero connection-count/pricing figures disagreed between two research passes (5 vs. 25 per
  app)** — mitigated by the resolution to Open Question 1: with each customer on their own
  single-organisation app, the exact cap doesn't matter (1 connection is well under either
  number). No further action needed unless Xero's policy changes again.
- **`posting.ts`'s hardcoded QBO import is a real, pre-existing architectural gap** (not
  introduced by this chunk) that this chunk is now responsible for closing. If the dispatcher
  generalization is skipped or rushed, Xero could ship "complete" per its own contract tests while
  remaining completely unreachable from live posting — exactly the kind of fake-completion this
  project's own audit skills exist to catch. The Integration test scenario above exists
  specifically to make that failure mode visible before it can be called done.
- **No API endpoint exists to convert a Xero Purchase Order to a Bill**, and Xero provides no
  linkage field between a Bill and the PO it may have originated from if created independently.
  This chunk's `capabilities().purchaseOrders` should stay honest about that limitation rather
  than imply PO→Bill automation Xero's API cannot actually provide.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_10_XERO_CONNECTOR</promise>
