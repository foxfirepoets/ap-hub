# SPEC: Windows Local-Only AP Hub Runtime

## Metadata
- Version: 1.0 | Date: 2026-07-25 | Tier: FULL | Greenfield/Brownfield: Brownfield
- Status: Ready for Build
- Success measure: On a standard-user Windows installation, AP Hub starts automatically after sign-in, remains bound only to loopback, polls Gmail continuously, downloads and classifies invoices and bank statements, prepares human-send-only Gmail drafts, and posts an owner-approved test transaction through each configured QuickBooks transport without requiring a publicly reachable AP Hub URL.
- Architecture grounding: `architecture-decision-packet-ap-hub-multi-edition-accounting-intake-2026-07-24.md` — verdict `READY_FOR_SPEC`
- Open questions: 0

## Tech Stack

- Windows 10/11, standard-user installation; no administrator or Windows service account required.
- Node.js 20+ and TypeScript ESM.
- Next.js 14 App Router UI bound to `127.0.0.1:3000`.
- Existing Node HTTP/worker process bound to `127.0.0.1:3001`.
- Local PostgreSQL plus pg-boss for system-of-record data, scheduling, retries, and durable jobs.
- Google OAuth 2.0 Desktop application client with Authorization Code + PKCE and a temporary loopback callback.
- QuickBooks connector registry supporting:
  - QBO direct API with a registered localhost callback where the configured Intuit environment permits it.
  - QBO outbound API/MCP adapter where the adapter owns authorization and AP Hub needs no inbound callback.
  - QuickBooks Desktop Web Connector/qbXML on the same Windows machine.
- Windows Credential Manager Generic Credentials through a `WindowsCredentialManagerSecretStore` implemented with the Win32 Credential Management API; no plaintext token or master key files.
- Existing Vitest, Playwright, ESLint, TypeScript, and live integration test harness.
- No hosting platform is part of the target runtime.

## Architecture Grounding Summary

### Systems touched

| System | Existing authority | Required change |
|---|---|---|
| Runtime boot | `src/index.ts`, `src/queue.ts`, `src/pipeline/register.ts` | Preserve the combined HTTP + pg-boss worker process; add explicit local-runtime health and supervision signals. |
| Local UI | `app/**`, `npm run web:start` | Bind to loopback, remove hosted-login dependency, establish a single-Windows-user local session. |
| Gmail OAuth | `src/auth/gmail-oauth.ts`, routes, token services | Replace web-client assumptions with Desktop client + PKCE + loopback callback; preserve Gmail read and draft-only scopes. |
| QBO connectivity | connector registry, QBO OAuth/client code | Add transport choice: direct local OAuth, outbound API adapter, or custom MCP adapter. All transports implement one accounting contract and identical write gates. |
| QuickBooks Desktop | `src/qbdesktop/**` | Keep QBWC/qbXML local and durable; never relay QBD data through a hosted service. |
| Secret storage | `src/host/types.ts`, `src/host/windows.ts`, token encryption | Replace DPAPI-encrypted files with Windows Credential Manager Generic Credentials; migrate safely and delete old secret files only after verification. |
| Installer/watchdog | `deploy/**`, Windows host adapter | Make local-only install the canonical product path; start backend and UI after Windows sign-in and restart them after failure. |
| Configuration/docs | `.env.example`, `INSTALL.md`, `README.md`, operator docs | Remove required hosted URLs and provider secrets from `.env`; document local and outbound-adapter modes truthfully. |
| Tests | `test/**`, `e2e/**`, live harness | Add loopback, PKCE, Credential Manager, supervision, no-public-bind, and transport parity proof. |

### Systems not touched

- Existing accounting-document, statement, proposal, exception, posting, reconciliation, proof, and audit state machines except where provider transport metadata must be recorded.
- Gmail sending: AP Hub remains structurally unable to send a reply.
- QuickBooks remains the authoritative source after an external posting.
- Tenant isolation and role/write gates remain enforced even in single-owner local mode.
- No Vercel, public callback relay, inbound tunnel, public DNS record, remote admin UI, cloud queue, or cloud database is introduced.
- Xero, Sage, payroll, payments, tax filing, and bank credential aggregation remain out of scope.

### Source of truth

| Entity | Source of truth |
|---|---|
| Windows operator identity | Current interactive Windows user SID recorded during installation |
| Runtime secrets and provider tokens | Windows Credential Manager entries scoped to that Windows user |
| AP Hub workflow state | Local PostgreSQL |
| Gmail messages and drafts | Gmail; AP Hub stores projections, evidence, and provider IDs |
| QBO/QBD accounting transactions | Connected QuickBooks company; AP Hub stores intent, result, and reconciliation |
| Job state | Local PostgreSQL/pg-boss |
| Runtime installation state | `%LOCALAPPDATA%\APHub\install.json`, containing identifiers and non-secret configuration only |

### State machines

- Runtime: `stopped → starting → healthy → degraded → restarting → healthy|failed`.
- Provider connection: `unconfigured → authorizing → connected → refresh_required|held → connected|disconnected`.
- Secret migration: `not_started → copied → verified → legacy_deleted`; failures return to `not_started` with the legacy secret untouched.
- Existing document, proposal, posting, statement, draft, and provider-job state machines remain authoritative as defined in the architecture packet.

### Money, authentication, and customer-data boundaries

- QuickBooks writes remain proof-gated, tenant/connection-bound, idempotent, read back, reconciled, and audited.
- Gmail authorization grants only required read and compose/draft permissions; no application send operation exists.
- Local UI access is restricted to loopback and the Windows user that installed AP Hub.
- MCP/API adapters are treated as external privileged providers, not as authentication bypasses. They must present an authenticated local or outbound-only connection and declare exact capabilities.
- Customer documents and database records remain local unless explicitly sent to the configured LLM or provider API as required for the selected workflow.

### Reuse decisions

- Reuse `src/index.ts`, pg-boss scheduling, pipeline jobs, connector interfaces, QBO/QBD posting contracts, audit/proof gates, local installer, watchdog, and host adapter seam.
- Replace hosted Google SSO for product access with Windows-local ownership; do not maintain two login authorities.
- Replace DPAPI secret files rather than adding a second long-lived token store.
- Extend the connector registry for API/MCP transport modes; do not create parallel posting services.

### Must not break

1. Invoice and bank-statement intake, classification, evidence, and review.
2. Gmail drafts remain human-send-only.
3. QBO/QBD write gates, idempotency, company identity verification, read-back, reconciliation, and audit.
4. Cross-tenant and role isolation.
5. Existing CLI pause/resume/poll and recovery behavior.
6. Existing 484-test and 24-browser-contract baseline.

## 1. Executive Summary

AP Hub will become a private Windows application for any small-to-medium-sized business owner, with no required website, public callback, or remote-access surface. It will open at localhost, start automatically with Windows, continuously process Gmail accounting documents, prepare drafts that only a human can send, and connect to supported QuickBooks editions through a local QBO OAuth flow, an authenticated outbound API/custom MCP transport, or local QuickBooks Desktop Web Connector. The build is estimated at 2–3 weeks of agent work because it changes authentication, credential custody, privileged accounting transports, installation, and continuous-process supervision.

## 2. Scope & Do Not Build

### In scope

- Canonical Windows-local installation under the current user.
- Backend/worker listener restricted to `127.0.0.1:3001`.
- Next.js UI restricted to `127.0.0.1:3000`.
- Browser launch to `http://127.0.0.1:3000` from installer/start-menu shortcut.
- Local-owner session established from an installation-bound, HttpOnly cookie and current Windows-user ownership.
- Removal of Google SSO as a requirement for entering the local product.
- Gmail Desktop OAuth with PKCE and loopback callback.
- Gmail read, attachment download, classification, invoice/statement workflow, and compose/draft scopes.
- QBO connector transport selection:
  - `direct_local_oauth`
  - `api_adapter`
  - `mcp_adapter`
- QBO sandbox localhost callback support.
- QBO API/MCP transports that initiate outbound connections only and require no public AP Hub URL.
- QBD Web Connector and qbXML on the local machine.
- Actual Windows Credential Manager storage for:
  - AP Hub encryption key
  - session secret
  - Gmail refresh/access tokens and client secret when applicable
  - QBO refresh/access tokens and client secrets when applicable
  - API/MCP adapter credentials
  - QBWC password
  - optional LLM and proof-service credentials
- One-time verified migration from legacy DPAPI files and secret-bearing `.env` values.
- Per-user Task Scheduler watchdog that starts both processes after sign-in, checks health, and restarts failed processes.
- Continuous Gmail polling and pg-boss accounting workers while the Windows user session is active.
- Local health/status UI showing process, database, Gmail, QBO/QBD, queue, and last-success timestamps without exposing secrets.
- Local backup/restore documentation and credential export warning.

### Do Not Build

- Do not require Vercel, a VPS, public DNS, HTTPS certificates, tunnels, or an inbound callback relay; these contradict the private-local product requirement.
- Do not expose the UI or backend on `0.0.0.0`, a LAN address, or the public internet; remote access is explicitly unwanted.
- Do not claim that “API” or “MCP” removes QuickBooks authorization. The selected adapter must already be authorized or provide an explicit authorization flow.
- Do not scrape QuickBooks web pages or automate username/password entry; use supported QBO API/MCP or QBD Web Connector surfaces.
- Do not add Gmail send capability. Draft creation/update and “open in Gmail” are the final application actions.
- Do not run as `LocalSystem`, an administrator-only service, or a shared-machine daemon; Windows Credential Manager and Gmail/QB access are per interactive user.
- Do not copy OAuth tokens, master keys, or provider credentials into PostgreSQL plaintext, `.env`, `install.json`, logs, command lines, or browser storage.
- Do not add a second provider-specific posting engine; all QBO modes and QBD use the existing connector/posting contract.
- Do not auto-enable production accounting writes during installation or migration.
- Do not delete legacy secrets until Credential Manager read-back and a provider-independent encryption round trip succeed.
- Do not remove tenant/role isolation merely because the first distribution is single-user.

## 3. Business Context & Acceptance Criteria

### Goal

Give an SMB owner a private, continuously running AP assistant on their Windows machine without operating a public web application.

### Thirty-day success target

For 30 consecutive days of normal Windows use, at least 95% of scheduled Gmail polls start within 5 minutes of their due time; every supported invoice or statement received under the watched label becomes a reviewable document or a visible exception; zero emails are sent by AP Hub; zero duplicate QuickBooks transactions are created; and the owner completes at least one certified posting through every configured QuickBooks transport.

### Acceptance criteria

- [ ] `Get-NetTCPConnection` shows AP Hub ports listening only on `127.0.0.1` or `::1` — FAIL if either listens on `0.0.0.0`, a LAN address, or a public interface.
- [ ] With internet access available but no hosted AP Hub deployment, the owner opens `http://127.0.0.1:3000`, reaches the local application, and completes onboarding — FAIL if any AP Hub page or callback requires a public AP Hub origin.
- [ ] Gmail authorization uses a Google Desktop client, PKCE `S256`, a cryptographically random verifier/state, and a loopback callback — FAIL if a client secret is the primary desktop-client proof, PKCE is absent, state is replayable, or the callback accepts a non-loopback host.
- [ ] A Gmail message under the watched label is polled within 5 minutes, its supported attachments are downloaded once, and it becomes an invoice, bank statement, or typed visible exception — FAIL on silent loss or duplicate document rows.
- [ ] When a reply is needed, AP Hub creates or updates a Gmail draft in the source thread and exposes no send operation — FAIL if any AP Hub route/service calls Gmail `messages.send`, `drafts.send`, or an equivalent send transport.
- [ ] QBO sandbox direct mode completes authorization through a registered localhost callback and posts one approved disposable-company bill with read-back — FAIL if a public AP Hub callback is required or the bill is not reconciled.
- [ ] QBO API/MCP mode connects outbound to an authenticated adapter, reads the company identity/capabilities, and posts the same contract fixture with identical gates and read-back — FAIL if the adapter can bypass approval, proof, idempotency, identity, or reconciliation.
- [ ] QBD mode queues an approved bill durably, survives AP Hub restart, is leased only by the configured local QBWC company, and reconciles the BillAdd result — FAIL on lost/cross-company work or blind replay.
- [ ] Every named secret exists as a Windows Credential Manager Generic Credential and is absent from `.env`, `install.json`, logs, process command lines, and browser storage — FAIL on any plaintext secret observation.
- [ ] Migration copies, reads back, and verifies legacy secrets before deleting legacy DPAPI files; an injected verification failure leaves the old data usable — FAIL on premature deletion.
- [ ] After Windows sign-in, the watchdog brings database-dependent workers and UI to healthy state within 90 seconds; killing either process causes recovery within 90 seconds — FAIL if manual terminal startup is required.
- [ ] Disconnecting the network creates visible provider/job degradation without data loss; restoring it resumes polling/refresh within 5 minutes — FAIL on silent stoppage or duplicate replay.
- [ ] Existing lint, no-leak boundary scan, typecheck, all unit/integration tests, production web build, and Playwright contracts pass — FAIL on any regression.

### Definition of Done

DONE means ALL true in the DEPLOYED environment, with an artifact per item
(HTTP response, DB row, screenshot, log line):
1. Every acceptance criterion above is observed on a clean standard-user Windows install.
2. Live certification artifacts exist for Gmail, each configured QBO mode, and a disposable QBD company.
3. A reboot/startup, forced-process-crash, network-loss, and backup/restore drill have passed.

NOT done if:
- Verified only in unit mocks; the installed Windows environment is the deployment target.
- "Code looks correct" / "tests should pass" — only observed behavior counts.
- Any must-not-break item is untested.
- Any provider is called with placeholder credentials.

## 4. Architecture & System Integration

```text
Windows user signs in
  → Task Scheduler: APHubWatchdog
      → local PostgreSQL readiness
      → AP Hub backend + pg-boss workers (127.0.0.1:3001)
      → Next.js UI (127.0.0.1:3000)
      → health/restart supervision

Browser on same Windows profile
  → localhost UI
      → localhost API/backend
          → Windows Credential Manager
          → local PostgreSQL / pg-boss
          → Gmail API (outbound HTTPS)
          → QuickBooks connector registry
              ├─ QBO direct local OAuth/API (outbound HTTPS + loopback callback)
              ├─ authenticated API adapter (outbound HTTPS or loopback IPC)
              ├─ authenticated custom MCP adapter (local stdio/loopback or outbound HTTPS)
              └─ QBD Web Connector/qbXML (local loopback)
          → selected LLM runtime/API (local or outbound)
```

### Local ownership and session

- Installation records the current Windows user SID and a random installation ID.
- Backend startup compares the current SID with the installed SID and refuses to start on mismatch.
- The local UI has no Google login. The backend mints a short-lived, HttpOnly, `SameSite=Strict` local session only after a loopback request presents a one-time bootstrap nonce delivered through a protected local launch file/URL.
- Session cookies are host-only, secure against cross-site submission through strict SameSite and Origin validation, and never accepted from a non-loopback Host header.
- Mutation routes continue to apply tenant and role gates; the installed owner maps to the provisioned `owner_controller`.

### Gmail authorization

- OAuth client type is Desktop.
- AP Hub generates `state`, `code_verifier`, and `code_challenge=S256`.
- It binds a temporary callback listener to `127.0.0.1` on an available port selected at authorization time.
- The exact loopback URI used in the authorization request is used for token exchange.
- Callback state is single-use and expires after 10 minutes.
- Refresh tokens are written directly to Credential Manager; the database stores a credential reference and non-secret metadata, not token ciphertext.

### QuickBooks transport abstraction

All modes implement:

```ts
interface QuickBooksTransport {
  mode: 'direct_local_oauth' | 'api_adapter' | 'mcp_adapter' | 'qb_desktop';
  capabilities(): Promise<ProviderCapabilities>;
  verifyCompany(expected: CompanyBinding): Promise<VerifiedCompany>;
  findByIdempotencyKey(key: string): Promise<ProviderTransaction | null>;
  postBill(intent: CanonicalBillIntent): Promise<ProviderMutationResult>;
  readBack(ref: ProviderTransactionRef): Promise<ProviderTransaction>;
  health(): Promise<TransportHealth>;
}
```

- Direct QBO OAuth uses localhost only where the configured Intuit app/environment accepts that redirect.
- API and MCP modes do not require an inbound AP Hub callback. The adapter may run locally or accept outbound authenticated requests. It must return authoritative company identity, capability, mutation identity, and read-back evidence.
- A custom MCP server is privileged accounting infrastructure. AP Hub allowlists exact tool names and JSON schemas; it rejects arbitrary tool execution, prompt-generated tool names, missing idempotency support, or transports without read-back.
- QBD remains a QBWC polling transport on localhost.

### New infrastructure

No hosted infrastructure. New local components are limited to:

- Windows Credential Manager implementation.
- Local runtime supervisor/watchdog changes.
- QBO API/MCP transport adapters and capability configuration.
- Optional local MCP child process supervised through the existing `HostAdapter`.

## 5. User Flows & Happy Path

### Flow A — Install and open

Actor: SMB owner using their Windows account.

Preconditions: Windows 10/11, Node/runtime bundle and PostgreSQL installer available.

1. Owner launches the guided installer without elevation.
2. Installer creates `%LOCALAPPDATA%\APHub`, restricts ACLs, records the Windows SID, installs/migrates PostgreSQL, provisions the owner, and registers `APHubWatchdog`.
3. Installer creates required secrets in Windows Credential Manager.
4. Watchdog starts backend/workers and UI.
5. Installer opens `http://127.0.0.1:3000` with a one-time local bootstrap nonce.
6. UI establishes the owner session and invalidates the nonce.

Postcondition: status page reports local runtime and database healthy; no public URL exists.

### Flow B — Connect Gmail and process documents

1. Owner clicks Connect Gmail.
2. AP Hub starts a temporary loopback callback listener, generates PKCE/state, and opens the system browser.
3. Owner grants read and compose/draft scopes.
4. AP Hub validates state and exchanges the code using PKCE.
5. Token is stored in Credential Manager; connection metadata becomes connected.
6. Scheduled poll reads the watched label, downloads attachments, deduplicates them, classifies invoice/statement, and creates review items or exceptions.

Postcondition: the local UI shows the source evidence and next action.

### Flow C — Post through QuickBooks

1. Owner selects direct QBO, API adapter, MCP adapter, or QBD.
2. AP Hub verifies live company identity and exact connector capabilities.
3. Owner reviews and approves a proposal.
4. Existing proof, amount, role, dry-run, identity, and idempotency gates run.
5. Transport probes for an existing result, creates only when safe, reads back, reconciles, and audits.

Postcondition: one QuickBooks transaction exists and matches the approved intent.

### Flow D — Draft a reply

1. An exception indicates missing or ambiguous invoice information.
2. AP Hub proposes draft content.
3. Owner edits and selects Create/Update Gmail Draft.
4. AP Hub writes a draft in the source thread.
5. Owner opens Gmail and decides whether to send it.

Postcondition: AP Hub records the draft ID and audit event but never sends.

### Alternate 1 — Adapter unavailable

The provider job remains queued or held with `TRANSPORT_UNAVAILABLE`; the watchdog does not invent success. After reconnection, duplicate/read-back probes run before mutation retry.

### Alternate 2 — Wrong QuickBooks company

Company verification returns `COMPANY_MISMATCH`; writes are blocked until the owner reconnects/selects the intended company.

### Alternate 3 — Computer restarted

Task Scheduler starts the watchdog after sign-in. Durable jobs resume from PostgreSQL; leases expire safely; Gmail cursor and idempotency keys prevent duplicate work.

## 6. Data Models & Schema

### Credential references

Add non-secret references; never store credential values:

```sql
CREATE TABLE credential_refs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL,
  credential_target TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, purpose)
);
```

Validation:

- `credential_target` must match `^APHub/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$`.
- `metadata` may contain scope, expiry, provider account ID, and last refresh status.
- `metadata` must reject token/key/secret/password fields recursively.

Valid:

```json
{
  "provider": "gmail",
  "purpose": "oauth_refresh",
  "credential_target": "APHub/7F3A2/gmail-refresh",
  "metadata": {"scope":["gmail.readonly","gmail.compose"],"expires_at":"2026-07-25T20:00:00Z"}
}
```

Invalid:

```json
{"credential_target":"APHub/7F3A2/gmail-refresh","metadata":{"refresh_token":"plaintext"}}
```

### Provider connections

Add to `connections`:

```sql
ALTER TABLE connections
  ADD COLUMN transport_mode TEXT,
  ADD COLUMN transport_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT connections_transport_mode_check
    CHECK (transport_mode IS NULL OR transport_mode IN
      ('direct_local_oauth','api_adapter','mcp_adapter','qb_desktop'));
```

`transport_config` may contain non-secret endpoint/command identifiers, tool allowlists, expected company identifiers, and timeouts. It must not contain credentials.

Example MCP configuration:

```json
{
  "transport":"stdio",
  "command_id":"registered-qbo-mcp",
  "allowed_tools":["company_info","find_bill","create_bill","read_bill"],
  "timeout_ms":30000
}
```

Invalid MCP configuration:

```json
{"transport":"stdio","command":"powershell -EncodedCommand ...","allowed_tools":["*"]}
```

### Local installation file

`%LOCALAPPDATA%\APHub\install.json`:

```json
{
  "version":1,
  "install_id":"7F3A2",
  "owner_sid":"S-1-5-21-...",
  "tenant_id":1,
  "ui_origin":"http://127.0.0.1:3000",
  "backend_origin":"http://127.0.0.1:3001"
}
```

No secret fields are permitted.

## 7. Error Handling & Edge Cases

| Scenario | Status | Code | Response / Recovery |
|---|---:|---|---|
| Non-loopback Host/Origin | 403 | `LOCAL_ONLY` | Refuse request; log safe network metadata. |
| Wrong Windows SID | startup failure | `OWNER_SID_MISMATCH` | Do not start providers/workers; instruct reinstall/migration under intended user. |
| Bootstrap nonce reused/expired | 403 | `BOOTSTRAP_INVALID` | Generate a new local launch nonce. |
| Gmail state/PKCE mismatch | 400 | `OAUTH_STATE_INVALID` | Discard code; restart connection flow. |
| Gmail callback arrives on wrong interface | 400 | `LOOPBACK_REQUIRED` | Close listener; no token exchange. |
| Credential Manager unavailable | 503 | `SECRET_STORE_UNAVAILABLE` | Stop provider startup; preserve jobs; show repair guidance. |
| Secret migration verification fails | 409 | `SECRET_MIGRATION_FAILED` | Keep legacy value, remove unverified new entry, retry. |
| QBO direct localhost rejected by provider | 422 | `REDIRECT_MODE_UNSUPPORTED` | Configure an authorized API/MCP adapter; do not request public AP Hub hosting automatically. |
| API/MCP authentication fails | 401 | `TRANSPORT_AUTH_REQUIRED` | Reauthorize adapter; no posting retry. |
| MCP exposes missing/extra tools | 422 | `MCP_CAPABILITY_MISMATCH` | Hold connection until allowlist matches. |
| MCP output violates schema | 502 | `MCP_RESPONSE_INVALID` | Hold mutation; never infer external success. |
| Wrong QBO/QBD company | 409 | `COMPANY_MISMATCH` | Block all writes and reconnect/select correct company. |
| Mutation times out | 202 | `OUTCOME_UNCERTAIN` | Hold; query by idempotency key/read-back before any retry. |
| Watchdog restart loop | local degraded | `PROCESS_CRASH_LOOP` | Back off 5s, 15s, 30s, then stop after 5 failures/10 min and show log path. |
| PostgreSQL unavailable | 503 | `DATABASE_UNAVAILABLE` | Workers remain stopped; watchdog retries readiness. |
| Network unavailable | 503 | `PROVIDER_OFFLINE` | Durable backoff; visible status; resume without cursor advance. |
| Gmail compose scope missing | 403 | `GMAIL_COMPOSE_REQUIRED` | Preserve proposed copy; reconnect Gmail. |
| Attempted email send route | 404 | `NOT_FOUND` | No route/service/tool exists. |

Edge cases:

- Multiple AP Hub tabs reuse one valid local session without generating multiple owner identities.
- A second Windows user cannot decrypt/read credentials or obtain a local owner session.
- Dynamic OAuth callback ports may be occupied; select another loopback port before opening the browser.
- OAuth callback received after listener shutdown fails without writing tokens.
- Windows sleeps during a poll; wake resumes from the last committed Gmail history cursor.
- Clock drift greater than 5 minutes creates a visible `CLOCK_SKEW` warning before OAuth or lease processing.
- MCP child process writes malformed stdout or excessive output; bound responses to 2 MiB and terminate the request safely.
- Credential deletion/disconnect is idempotent and revokes provider tokens when supported.

## 8. Performance & Scalability

- Target one Windows user, 1–10 connected companies, and up to 5,000 accounting documents/month.
- Local UI health endpoint p95 under 250 ms when PostgreSQL is healthy.
- Review-list API p95 under 1 second for 50,000 stored documents with pagination.
- Gmail scheduled poll starts within 5 minutes of due time for 95% of runs while Windows is awake.
- Watchdog identifies a dead child within 30 seconds and restores health within 90 seconds.
- Credential Manager get/put p95 under 500 ms.
- Provider adapter default timeout 30 seconds; posting may remain asynchronous rather than holding an HTTP request.
- Maximum attachment remains 25 MiB unless the existing configured ceiling is lower.
- MCP response maximum 2 MiB; provider request artifacts are redacted and bounded.
- No hosted infrastructure cost. External LLM/provider API costs remain operator-selected and are surfaced through existing call metadata.

## 9. Security & Compliance

### Authorization

- Only the Windows SID that installed AP Hub may start the runtime or establish the owner session.
- Loopback alone is not authentication. One-time bootstrap nonce, host/origin checks, HttpOnly session cookies, CSRF protection, and existing RBAC remain required.
- Bookkeeper/CPA roles remain available for later local profiles but are not silently mapped from other Windows users.

### Secret custody

- Use Windows Credential Manager Generic Credentials under `APHub/<install-id>/<name>`.
- Invoke Win32 `CredWriteW`, `CredReadW`, and `CredDeleteW` through a bundled, source-controlled helper based on the existing host seam; do not depend on a user-installed PowerShell module.
- Credential values never cross command-line arguments. Helper IPC uses inherited stdin/stdout with bounded messages and redacted errors.
- PostgreSQL stores credential references and token metadata only.
- Legacy encrypted `oauth_tokens` columns remain readable during migration, then are nulled only after verified Credential Manager cutover; schema removal is deferred.

### Network restrictions

- Both listeners bind explicitly to `127.0.0.1`.
- Validate `Host` against the configured loopback host/port.
- Reject forwarded-host headers and do not trust proxy headers.
- Windows Firewall exposure is unnecessary because no non-loopback bind exists.
- API/MCP remote calls are outbound TLS only. Local MCP uses supervised stdio or authenticated loopback.

### Accounting and email safety

- Every QuickBooks transport enforces the same company, capability, proof, approval, ceiling, idempotency, read-back, reconciliation, and audit gates.
- MCP tool responses are untrusted input validated against exact schemas.
- Gmail scope does not include sending when the provider permits narrower scopes; runtime source and architecture tests prohibit send APIs regardless of granted scope.

### Data protection

- Database and attachment files are ACL-restricted to the Windows owner.
- Backups contain financial data and credential references; credentials require a separate, deliberate owner-controlled recovery process.
- Logs exclude document bodies, attachment bytes, OAuth codes, tokens, secrets, full MCP payloads, and QBWC passwords.
- No formal compliance certification is claimed. The owner remains responsible for bookkeeping review, retention, and provider terms.

## 10. Testing Strategy

### Named automated tests

| Requirement / must-not-break | Test |
|---|---|
| Loopback-only UI/backend | `test/local-bind-contract.test.ts` starts both listeners and inspects bound addresses; Playwright rejects a non-loopback Host. |
| Local owner session | `test/windows-local-session.test.ts` covers SID match/mismatch, nonce single use/expiry, CSRF, and foreign Origin. |
| Gmail Desktop OAuth | `test/gmail-desktop-oauth.test.ts` asserts PKCE S256, random state, dynamic loopback, exact redirect reuse, replay refusal, and Credential Manager save. |
| Gmail intake/dedup | Existing ingest/poll tests plus live disposable-mailbox trace. |
| Draft-only Gmail | Existing reply-draft architecture tests plus a repository scan banning `messages.send`/`drafts.send`. |
| Credential Manager | `test/windows-credential-manager.test.ts` performs put/get/update/delete as standard user and verifies no plaintext filesystem/process leakage. |
| Safe secret migration | `test/credential-migration.test.ts` covers copy/verify/delete and injected rollback. |
| QBO direct localhost | `test:qbo-local-live` against sandbox; captures callback host and reconciled disposable bill. |
| API/MCP parity | `test/qbo-transport-contract.test.ts` runs the same capability/company/idempotency/post/read-back fixture against direct, API fake server, and MCP test server. |
| MCP hostility | `test/mcp-qbo-boundary.test.ts` covers unknown tool, schema injection, oversized output, timeout, ambiguous success, and company mismatch. |
| QBD durability | Existing QBD posting contract plus restart/lease/cross-company live disposable-file certification. |
| Watchdog | `test/windows-watchdog.test.ps1` installs task, kills child processes, observes bounded restart/backoff, reboots, and confirms health. |
| Existing document flows | Entire existing `npm run verify` gate, never replaced by narrower tests. |
| Network recovery | Integration test disables outbound connectivity, observes visible holds, restores it, and proves effective-once recovery. |

### Required commands

```powershell
npm run lint
npm run lint:noleak
npm run typecheck
npm test
npm run web:build
npm run test:ui-contract
npm run verify:live
```

Installed-environment certification runs on a disposable standard-user Windows profile and produces:

- listener-address evidence;
- Credential Manager target-name listing with values redacted;
- Task Scheduler task status;
- process recovery timestamps;
- Gmail message/draft IDs;
- QBO/QBD test-company transaction IDs and reconciliation rows;
- database row counts and audit entries.

## 11. Deployment & Rollout

The deployment target is the owner’s Windows machine.

### Install

```powershell
deploy\Install-ap-hub.cmd
```

The installer must:

1. Refuse elevation unless an independently required dependency installer explicitly needs it.
2. Install to `%LOCALAPPDATA%\APHub`.
3. Restrict ACLs to the current user.
4. Record SID/install ID and non-secret ports.
5. Create Credential Manager secrets interactively or through provider authorization.
6. Install/migrate local PostgreSQL.
7. Register the per-user `APHubWatchdog` scheduled task.
8. Start and verify backend/UI health.
9. Open localhost onboarding.

### Non-secret configuration names

`DATABASE_URL` may be reconstructed from a Credential Manager password plus local host/database metadata. Remaining non-secret configuration includes:

- `WATCHED_LABEL`
- `MAX_ATTACHMENT_BYTES`
- `QBO_ENV`
- `QBO_MINOR_VERSION`
- `QB_DESKTOP_ENABLED`
- `QB_DESKTOP_COMPANY_ID`
- `QB_DESKTOP_TENANT_ID`
- `QB_DESKTOP_CONNECTION_ID`
- `QB_DESKTOP_WRITE_ENABLED`
- `PROVIDER_JOB_LEASE_SECONDS`
- `AUTO_THRESHOLD`
- `REVIEW_THRESHOLD`
- `AMOUNT_CEILING`
- `POLL_INTERVAL_SECONDS`
- `PORT=3001`
- `WEB_BASE_URL=http://127.0.0.1:3000`

Secret values formerly represented by environment variables are loaded from Credential Manager and injected into the process in memory only.

### Verify installed environment

```powershell
Invoke-WebRequest http://127.0.0.1:3001/health
Invoke-WebRequest http://127.0.0.1:3000/login
Get-ScheduledTask -TaskName APHubWatchdog
Get-NetTCPConnection -State Listen | Where-Object LocalPort -In 3000,3001
```

Expected: health `200`, UI `200`, task Ready/Running, and listeners only on loopback.

### Rollback

- Installer retains the prior version under `%LOCALAPPDATA%\APHub\versions/<version>` until new-version certification passes.
- `deploy\rollback.ps1 -Version <previous>` stops children, switches the active version pointer, runs only compatible migration-down steps, and restarts.
- Credential migration rollback keeps verified prior entries until the full release is accepted.
- No migration may drop or truncate accounting data during automated rollback.

## 12. API Documentation

All endpoints accept loopback requests only and require the local session unless noted.

### Local runtime

`GET /health` — Auth: none, loopback only  
`200: { status, database, queue, workers, version }`  
`503: { status:"degraded", code }`  
No secrets, company data, or provider payloads.

`POST /api/local-session/bootstrap` — Auth: one-time bootstrap nonce, loopback only  
Req: `{ nonce }`  
`204` plus HttpOnly local session cookie  
`403 BOOTSTRAP_INVALID | OWNER_SID_MISMATCH | LOCAL_ONLY`

`GET /api/runtime/status` — Auth: owner session  
`200: { backend, ui, database, queue, gmail, quickbooks[], lastPollAt, lastSuccessfulJobAt }`

### Gmail connection

`POST /api/connections/gmail/start` — Auth: owner  
Req: `{}`  
`200: { authorizationUrl, expiresAt }`  
The URL contains PKCE challenge and a loopback redirect; it contains no secret.

`GET http://127.0.0.1:{dynamicPort}/oauth/gmail/callback` — Auth: OAuth state + PKCE  
Query: `code`, `state`  
`302` to `http://127.0.0.1:3000/onboarding?connected=gmail`  
`400 OAUTH_STATE_INVALID | OAUTH_EXCHANGE_FAILED`

### QuickBooks connection

`POST /api/connections/quickbooks` — Auth: owner  
Req:

```json
{
  "provider":"qbo",
  "transportMode":"direct_local_oauth|api_adapter|mcp_adapter",
  "expectedCompany":{"realmId":"optional","name":"Expected Company"},
  "transportConfig":{"registeredAdapterId":"optional"}
}
```

`201: { connectionId, status, authorizationAction }`  
`400 VALIDATION | 409 COMPANY_MISMATCH | 422 UNSUPPORTED_CAPABILITY`

`POST /api/connections/quickbooks/{id}/authorize` — Auth: owner  
Direct mode returns a provider URL/local callback action. API/MCP mode starts the registered adapter authorization handshake or verifies an already-authorized adapter.  
`200: { status, action } | 401 TRANSPORT_AUTH_REQUIRED | 422 REDIRECT_MODE_UNSUPPORTED`

`GET /api/connections/quickbooks/{id}/capabilities` — Auth: owner  
`200: { company, transportMode, operations, limitations, verifiedAt }`

### Existing posting and drafts

Existing proposal approval, provider write-gate, reply-draft, document, statement, exception, transaction, and audit endpoints retain their contracts. They gain no public exposure and no email-send endpoint.

Rate limits:

- Bootstrap: 5 attempts/minute, then 10-minute local lockout.
- OAuth/adapter starts: 10/hour per provider connection.
- Posting endpoints: existing effective-once concurrency controls plus 30 requests/minute.

## 13. Database Migrations

Create `migrations/013_local_runtime_credentials.sql`:

```sql
-- UP
CREATE TABLE credential_refs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL,
  credential_target TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, purpose),
  CHECK (credential_target ~ '^APHub/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$')
);

ALTER TABLE connections
  ADD COLUMN transport_mode TEXT,
  ADD COLUMN transport_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT connections_transport_mode_check
    CHECK (transport_mode IS NULL OR transport_mode IN
      ('direct_local_oauth','api_adapter','mcp_adapter','qb_desktop'));

CREATE INDEX credential_refs_tenant_provider_idx
  ON credential_refs (tenant_id, provider);

-- DOWN (allowed only if no credential_refs and no non-null transport_mode)
ALTER TABLE connections DROP CONSTRAINT connections_transport_mode_check;
ALTER TABLE connections DROP COLUMN transport_config;
ALTER TABLE connections DROP COLUMN transport_mode;
DROP TABLE credential_refs;
```

Migration runner must refuse DOWN when:

```sql
SELECT EXISTS (SELECT 1 FROM credential_refs)
    OR EXISTS (SELECT 1 FROM connections WHERE transport_mode IS NOT NULL)
    AS rollback_blocked;
```

Verification:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema='public' AND table_name='credential_refs';

SELECT column_name
FROM information_schema.columns
WHERE table_name='connections'
  AND column_name IN ('transport_mode','transport_config')
ORDER BY column_name;
```

Legacy `oauth_tokens` ciphertext columns are not dropped in this phase. After migration, their values may be nulled only per row after Credential Manager verification and an audit record; destructive schema removal requires a separate future spec.

## 14. Known Limitations, Open Questions & Future Work

### Known limitations

- AP Hub runs only while the owning Windows profile can run its per-user scheduled task. It is not a machine-wide unattended service before Windows sign-in.
- Direct QBO localhost authorization depends on the configured Intuit app/environment accepting that callback. Where it does not, the owner must use an authorized API/MCP adapter; AP Hub itself still remains local.
- API/MCP does not bypass QuickBooks permission or provider terms. It changes where authorization is held and how AP Hub transports commands.
- A Windows Credential Manager backup is not automatically portable to another Windows account or machine.
- Sleep/hibernation pauses active work; durable jobs resume after wake.
- Local-only operation does not provide remote review or mobile access.

### Open questions

None. Transport selection is runtime configuration behind one verified connector contract, not a build-blocking architectural decision.

### Future work

- Signed MSIX packaging and automatic local updates.
- Optional encrypted owner-controlled backup bundle and guided machine migration.
- Additional local Windows profiles with explicit role mapping.
- Provider-certified production QBO adapter packaging if Intuit distribution requirements demand it.

## Risks

1. A custom MCP adapter could become a privileged bypass around accounting gates. Mitigation: fixed tool/schema allowlist, company verification, idempotency probe, read-back, and all writes routed through the existing posting service.
2. Credential migration could strand provider access. Mitigation: copy/read-back/cryptographic verification before deletion, per-secret audit, and failure rollback.
3. Localhost could be mistaken for authentication. Mitigation: SID ownership, one-time bootstrap nonce, session/CSRF/Origin/Host validation, and loopback binding.
4. Watchdog restart loops could duplicate uncertain writes. Mitigation: durable leases, external read-back before retry, and bounded crash-loop backoff.
5. Direct QBO production localhost behavior may differ from sandbox. Mitigation: capability/configuration detection and API/MCP adapter fallback without public AP Hub hosting.
6. Windows sleep or logged-out state interrupts polling. Mitigation: durable cursors/jobs, wake recovery, and visible last-success status.

## 15. Glossary

- **Loopback:** Network interface accessible only from the same computer, normally `127.0.0.1`.
- **PKCE:** OAuth proof that the process exchanging an authorization code is the process that initiated authorization.
- **Credential Manager Generic Credential:** Windows user-scoped secret record managed by the Win32 credential APIs.
- **API adapter:** Authenticated provider-specific service/client that exposes the fixed AP Hub QuickBooks contract.
- **MCP adapter:** A constrained Model Context Protocol server exposing allowlisted QuickBooks tools; it is a transport, not an authorization bypass.
- **QBO:** QuickBooks Online through supported APIs/adapters.
- **QBD/QBWC:** QuickBooks Desktop and its polling Web Connector.
- **Installed environment:** The owner’s Windows machine; this is the deployed production target for this local-only product.

## 16. Monitoring & Metrics

### Local status

The status page and `/api/runtime/status` expose:

- backend/UI/database/queue health;
- watchdog last check and restart count;
- Gmail last poll start/success and cursor age;
- queued, leased, held, failed, and dead-letter job counts;
- each QuickBooks transport’s last identity verification and read-back;
- Credential Manager accessibility without listing values;
- disk space and last successful backup timestamp.

### Logs

- JSON logs under `%LOCALAPPDATA%\APHub\logs`.
- Rotate at 10 MiB, retain 10 files, redact secrets/customer bodies.
- Windows Event Log receives only startup, shutdown, crash-loop, database unavailable, credential-store unavailable, and provider-auth-required summaries.

### Alerts

- Local Windows toast when Gmail has not polled successfully for 15 minutes while awake.
- Local Windows toast for held/uncertain accounting writes immediately.
- Local Windows toast when disk free space falls below 5 GiB or last verified backup exceeds 14 days.
- No PagerDuty, hosted monitoring dashboard, or public health endpoint.

### Success query

An operator report calculates scheduled-vs-started polls, visible document outcomes, duplicate posting count, sent-email count (must remain zero), transport certifications, and worker uptime for the trailing 30 days.

## 17. Alternative Designs Considered

1. **Keep Vercel for UI and OAuth callbacks.** Rejected because remote access is unwanted and the public surface adds deployment, secret-custody, and operational burden without helping the local owner workflow.
2. **Use a tiny public QBO callback relay.** Rejected as the default because the owner requires no hosting; an authorized outbound API/MCP adapter provides the required transport when direct localhost is unavailable.
3. **Keep DPAPI-encrypted files.** Rejected because the explicit product requirement is Windows Credential Manager and a single inspectable secret inventory.
4. **Run as a Windows LocalSystem service.** Rejected because Gmail/QB authorization and Credential Manager entries belong to the interactive owner, and a service account increases privilege and secret-access complexity.

## 18. Build Phases & Final Checklist

### Build Phases

#### Phase 1 — Local-only runtime and ownership boundary

- Remove hosted-base assumptions from runtime configuration and installer.
- Bind backend/UI explicitly to loopback and reject non-loopback Host/Origin.
- Implement SID-bound bootstrap/session flow and remove Google SSO as a product-access dependency.
- Add local health/status contracts.
- Proof: listener inspection, hostile Host/Origin tests, local session E2E.

#### Phase 2 — Windows Credential Manager custody and migration

- Implement Win32 Credential Manager store behind `HostAdapter`.
- Add `credential_refs` and migration.
- Move master/session/provider/QBWC secrets out of `.env` and DPAPI files.
- Implement copy/verify/delete migration with rollback and audit.
- Proof: standard-user Credential Manager integration test and no-plaintext scan.

#### Phase 3 — Gmail Desktop OAuth loopback

- Implement Desktop client authorization with PKCE S256 and dynamic loopback listener.
- Store tokens in Credential Manager and metadata/reference in PostgreSQL.
- Preserve Gmail polling, attachment, classification, statement, and draft-only behavior.
- Proof: OAuth hostile tests and live disposable-mailbox message/draft trace.

#### Phase 4 — QuickBooks transport registry

- Add direct-local-OAuth, API-adapter, and constrained MCP-adapter modes behind the existing posting contract.
- Enforce fixed capabilities, company binding, idempotency, read-back, reconciliation, and audit.
- Preserve QBD QBWC local durable transport.
- Proof: shared transport contract suite plus hostile MCP boundary tests.

#### Phase 5 — Continuous Windows operation

- Update guided installer and per-user Task Scheduler watchdog for backend/UI/database readiness.
- Add bounded restart/backoff, wake/network recovery, status, logs, and local toasts.
- Proof: clean install, reboot, child-kill, network-loss, and recovery artifacts.

#### Phase 6 — Full regression and live certification

- Run full repository gate.
- Certify Gmail, QBO sandbox direct localhost, every configured API/MCP transport, and disposable QBD company.
- Run backup/restore and credential-migration rollback drills.
- Update claims/docs so no hosted URL, unsupported edition, email sending, or uncertified provider mode is implied.

### Final checklist

- [ ] Code implements every phase without a public AP Hub dependency.
- [ ] All §3 acceptance criteria have installed-environment artifacts.
- [ ] Existing invoice, statement, draft, QBO, QBD, proof, audit, RBAC, and isolation tests pass.
- [ ] Credential values are absent from repo, `.env`, database plaintext, filesystem secret files, logs, command lines, and browser storage.
- [ ] UI/backend bind only to loopback.
- [ ] Watchdog survives reboot and forced child termination.
- [ ] Gmail live poll and draft certification passes; no send capability exists.
- [ ] Each configured QuickBooks transport passes identity, duplicate, post, read-back, reconciliation, and audit certification.
- [ ] Documentation identifies API/MCP as authorized transports, not authorization bypasses.
- [ ] Rollback preserves accounting data and verified prior credentials.
- [ ] Run `truth-fix-loop`, then `spec-vs-build-brutal-audit` against this spec.

### AI Agent Execution Contract

The building agent must:
- [ ] Read the full spec + Architecture Grounding Summary before writing code
- [ ] Produce a plan/file-tree first — not code
- [ ] Test every "must not break" item before marking any phase complete
- [ ] Treat the Definition of Done as the ONLY completion signal
- [ ] Stop and escalate if a must-not-break guarantee is at risk — never ship around it
- [ ] Attach a concrete artifact per done condition (test output, HTTP log, DB row)
- [ ] Never mark done on local-only verification — deployed-environment proof required

For this specification, “deployed environment” means a clean installed standard-user Windows environment, not a hosted URL.
