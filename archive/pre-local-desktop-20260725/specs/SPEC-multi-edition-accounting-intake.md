# SPEC: Multi-Edition QuickBooks Accounting Intake

## Metadata
- Version: 1.0 | Date: 2026-07-24 | Tier: FULL | Greenfield/Brownfield: Brownfield
- Status: Ready for Build
- Success measure: Within 30 days of deployment, at least 95% of supported test documents reach the correct review/posting or filing workflow, with zero duplicate postings and zero application-sent Gmail replies.
- Architecture grounding: `architecture-decision-packet-ap-hub-multi-edition-accounting-intake-2026-07-24.md` — READY_FOR_SPEC
- Open questions: 0

## Tech Stack

- Node.js 20+ and TypeScript, npm
- Next.js 14 App Router for the SMB-owner web experience
- PostgreSQL 16 with SQL migrations; `pg` query layer
- pg-boss for durable application jobs
- Vitest for unit/integration tests and Playwright for UI contract tests
- Google Gmail API for read, attachment download, and draft creation/update
- Intuit QuickBooks Online Accounting API for QBO editions
- Intuit QuickBooks Web Connector/qbXML for supported Windows QuickBooks Desktop Pro, Premier, and Enterprise editions
- Existing configurable LLM extraction layer and SwarmSync proof layer
- Local Windows installer plus Docker Compose PostgreSQL; no new hosting platform is introduced

## Architecture Grounding Summary

Systems touched: canonical/accounting connector contracts, Gmail adapter/OAuth scopes, QBD QBWC protocol, posting orchestration, migrations, statement extraction/review, reply-draft API/UI, audit/reconciliation, installers/config, and tests.

Systems not touched: payroll, payments, tax filing, bank credential aggregation, Telegram gatekeeper alert semantics, Xero/Sage stubs, or live deployment.

| Entity | Source of truth |
|---|---|
| Gmail messages and drafts | Gmail; local IDs/status are projections |
| Source attachments and hashes | PostgreSQL attachments/blob records |
| Document/statement workflow | PostgreSQL canonical document and statement tables |
| Posting intent and evidence | PostgreSQL proposal/provider-job/posting/reconciliation/audit records |
| Posted accounting transaction | Connected QuickBooks company after verified create |
| Provider identity/capability | Local connection metadata confirmed by live provider query |
| Human identity and roles | PostgreSQL users/sessions |

Must not break:

1. No production QBO write during automated verification.
2. No application-driven Gmail reply send.
3. No proofless automatic posting.
4. No duplicate accounting transaction after timeout/retry.
5. No cross-tenant read, lease, draft, statement, or posting.
6. No direct provider import/write from core pipeline outside connector boundaries.
7. Existing invoice ingestion, review, QBO sandbox, auth, and audit tests stay green.

Reuse decisions: retain the canonical model, `AccountingConnector`, QBO adapter, pipeline, review UI, auth/RBAC, proof/audit services, and QBD SOAP/QWC/qbXML protocol. Replace only QBD process-memory work ownership with durable provider jobs. Keep gatekeeper forwarding as a separate locked capture workflow.

## 1. Executive Summary

AP Hub will become a human-supervised accounting intake product for any small-to-medium-sized business owner using a supported QuickBooks edition. It will read Gmail, download and classify invoices and bank statements, extract evidence, route uncertain items to review, file statements, post approved invoices through QuickBooks Online or supported Windows QuickBooks Desktop, and create Gmail drafts when clarification is needed. It will never send those drafts itself. The build is estimated at 3–4 weeks of agent work and is high-assurance because it handles customer email and external accounting writes.

## 2. Scope & Do Not Build

In scope:

- A provider/edition capability API and UI that identifies supported QuickBooks operations.
- QuickBooks Online bill posting through the existing connector, sandbox-only in automated verification.
- Supported Windows QuickBooks Desktop bill posting through QBWC/qbXML with durable queueing, identity verification, duplicate detection, read-back, and reconciliation.
- Canonical accounting-document routing for invoices and bank statements.
- Bank-statement header and line extraction, duplicate detection, arithmetic validation, review, match/exclude decisions, and evidence filing.
- Gmail draft creation/update/discard for questions related to an ingested message or exception.
- Human-only sending from Gmail; AP Hub may observe that a draft was sent but cannot invoke a send endpoint.
- Tenant-scoped APIs and UI for provider status, statements, and drafts.
- Additive migrations, installer/config updates, unit/integration/UI contract tests, and disposable-environment live test commands.

### Do Not Build

- Do not claim support for QuickBooks Mac, QuickBooks Self-Employed, discontinued products, or editions without a supported Intuit write surface; return an explicit unsupported capability instead.
- Do not implement automatic Gmail sending or a general recipient-addressed send API.
- Do not create journal entries automatically from bank statements.
- Do not enable or exercise production QBO or real-company QBD writes during automated build verification.
- Do not add bank-login aggregation, check scanning, payroll, payments, tax preparation/filing, reconciliation of every bank feed transaction, Xero, or Sage.
- Do not create a second posting pipeline, auth system, audit store, attachment store, or mapping system.
- Do not silently drop unsupported provider fields or coerce one transaction type into another.

## 3. Business Context & Acceptance Criteria

Business goal: let an SMB owner use one exception-driven workspace to turn accounting email into organized evidence and reviewed QuickBooks records without trusting invisible automation.

Target: ≥95% of supported fixture documents enter the correct invoice/statement workflow; zero duplicates and zero application-sent replies.

- [ ] `GET /api/provider-capabilities` reports QBO and supported QBD capabilities and returns `supported:false` plus a reason for unsupported editions/operations. FAIL if it claims universal compatibility without a capability result.
- [ ] An approved QBO sandbox bill and a simulated QBD bill both pass company verification, duplicate detection, create, read-back, reconciliation, and audit through the same posting contract. FAIL if core imports a provider writer directly.
- [ ] A QBD job remains queued across process restart and cannot be leased for another tenant or connection. FAIL on job loss or cross-tenant lease.
- [ ] Retrying after a simulated lost provider response adopts the existing transaction and creates no duplicate. FAIL if provider create is called twice.
- [ ] Invoice fixtures continue through the existing proof-gated proposal workflow. FAIL if any existing invoice regression test fails.
- [ ] Supported statement fixtures create one statement with ordered immutable lines, detect duplicate files/lines, validate balances, and route imbalanced statements to review. FAIL if an unbalanced statement becomes ready automatically.
- [ ] Statement review supports match, exclude-with-reason, correction-with-audit, and evidence filing. FAIL if filing creates an accounting write without a separate approved proposal.
- [ ] An authorized owner can create or update a Gmail draft in the source thread. FAIL if the adapter calls Gmail send or accepts an arbitrary send action.
- [ ] A bookkeeper may prepare drafts and statement reviews but may not post; a CPA remains read-only; an owner may approve posting. FAIL on any role escalation.
- [ ] Cross-tenant attempts against provider jobs, statements, lines, and drafts return 404/403 and do not reveal existence. FAIL if foreign data is returned or changed.
- [ ] `npm run verify` and broker tests pass. FAIL on a nonzero exit or an ERROR/FAIL marker.

DONE means ALL true in the DEPLOYED environment, with an artifact per item
(HTTP response, DB row, screenshot, log line):
1. Each acceptance criterion is observed against disposable Gmail, QBO sandbox, and QBD test-company environments where applicable.
2. Backup restoration is demonstrated before production accounting writes are enabled.
3. The capability UI matches the tested provider/edition matrix.

NOT done if:
- Verified only locally ("works on my machine" is not done)
- "Code looks correct" / "tests should pass" — only observed behavior counts
- Any must-not-break item is untested

## 4. Architecture & System Integration

```text
Gmail
  → message + attachment ingest
  → accounting_documents router
      → invoice → existing extract/map/proof/proposal
      → bank_statement → statement header/lines/validation/review/file
  → approved provider-neutral posting intent
      → QBO connector (synchronous REST)
      → QBD connector (durable provider_jobs → QBWC → qbXML)
  → provider read-back → posting + reconciliation + audit

exception/source thread
  → draft suggestion → Gmail draft create/update
  → human sends in Gmail (outside AP Hub)
```

New infrastructure is limited to additive PostgreSQL tables and pg-boss-compatible workers. QBD work is pulled asynchronously by Web Connector but owned durably by PostgreSQL. Every provider adapter declares capabilities before it receives work. Provider company identity must match the connection before a write job may be leased or executed.

The core pipeline deals in canonical bill/statement records. Provider translation, dedup queries, qbXML/REST payloads, and read-back parsing remain within connector modules. An unsupported operation becomes a held exception with a capability gap; it is never silently discarded.

## 5. User Flows & Happy Path

### Flow A — Invoice to QuickBooks

Actor: SMB owner. Preconditions: Gmail connected, supported QuickBooks company connected, onboarding dry run complete.

1. AP Hub reads a labeled Gmail message and downloads its PDF/image invoice.
2. It hashes, classifies, extracts, maps, and proof-checks the invoice.
3. Routine supported invoices become ready; uncertain items appear in Exceptions.
4. The owner reviews source evidence and approves.
5. AP Hub verifies company/capability and posts through QBO or queues a QBD provider job.
6. It reads back the transaction, reconciles, attaches evidence when supported, and displays the provider link/reference.

Postcondition: one verified external bill, one local posting projection, one reconciliation result, and append-only audit evidence.

Alternate: unsupported field/edition → held with exact capability explanation. Timeout after create → duplicate probe/read-back adoption.

### Flow B — Bank statement handling

Actor: SMB owner or bookkeeper. Preconditions: Gmail connected; statement attachment is readable.

1. AP Hub classifies the attachment as a statement and extracts institution/account hint, period, balances, currency, and ordered lines.
2. It verifies line uniqueness, date range, and balance arithmetic.
3. Valid statements enter review; invalid/ambiguous statements show the failing equation/fields.
4. The user matches or excludes lines with reasons and corrects extracted facts with audit history.
5. The user files the reviewed statement as evidence. Any proposed accounting transaction is a separate approval.

Postcondition: an immutable source-backed statement record with reviewed line dispositions and filing evidence.

Alternate: encrypted/unsupported PDF → held with remediation. Duplicate hash → existing statement link, no duplicate rows.

### Flow C — Draft a reply

Actor: owner or bookkeeper. Preconditions: source Gmail thread exists and compose scope is connected.

1. An exception recommends requesting missing information.
2. User opens Draft Reply, reviews/edits recipient derived from the source thread, subject, and body.
3. AP Hub creates or updates a Gmail draft in that thread.
4. UI links to Gmail. The user sends from Gmail.

Postcondition: Gmail owns the draft; AP Hub records draft ID/status/audit. No AP Hub send occurs.

Alternate: scope/token failure → draft remains proposed with reconnect action. CPA → read-only.

## 6. Data Models & Schema

### `accounting_documents`

| Column | Type / constraint |
|---|---|
| id | bigserial PK |
| tenant_id | bigint FK tenants, required |
| message_id | bigint FK messages, required |
| attachment_id | bigint FK attachments, nullable for body-only |
| kind | text CHECK invoice, bank_statement, unknown |
| sha256 | text required |
| status | text CHECK received, extracted, review, ready, filed, posted, held, rejected |
| classification_confidence | numeric(5,4), 0..1 |
| hold_reason | text nullable |
| created_at, updated_at | timestamptz |

Unique `(tenant_id, sha256, kind)`.

### `bank_statements`

| Column | Type / constraint |
|---|---|
| id | bigserial PK |
| tenant_id | bigint FK tenants |
| document_id | bigint UNIQUE FK accounting_documents |
| institution_name, account_hint, currency | text |
| period_start, period_end | date; end ≥ start |
| opening_balance, closing_balance | numeric(18,2) |
| extracted_fields | jsonb |
| status | text CHECK extracted, unbalanced, review, ready, filed, held |
| validation_detail | jsonb |
| filed_at | timestamptz nullable |

### `bank_statement_lines`

| Column | Type / constraint |
|---|---|
| id | bigserial PK |
| tenant_id | bigint FK tenants |
| statement_id | bigint FK bank_statements ON DELETE RESTRICT |
| line_no | integer > 0 |
| posted_on | date |
| description | text required |
| amount, balance | numeric(18,2); balance nullable |
| fingerprint | text required |
| match_status | text CHECK unmatched, suggested, matched, excluded |
| matched_provider_ref | jsonb nullable |
| review_reason | text nullable |

Unique `(statement_id,line_no)` and `(tenant_id,fingerprint)`.

### `provider_jobs`

| Column | Type / constraint |
|---|---|
| id | bigserial PK |
| tenant_id | bigint FK tenants |
| connection_id | bigint FK connections |
| proposal_id | bigint FK proposals nullable |
| operation | text CHECK verify_company, query, post_bill, read_back, attach |
| request_payload | jsonb required; qbXML stored as a field when QBD |
| response_payload | jsonb nullable and redacted |
| status | text CHECK queued, leased, sent, succeeded, failed, held |
| idempotency_key | text required |
| lease_token, leased_at, lease_expires_at | nullable |
| attempts | integer default 0 |
| error_code, error_detail | nullable |
| created_at, updated_at | timestamptz |

Unique `(tenant_id,connection_id,idempotency_key,operation)`.

### `reply_drafts`

| Column | Type / constraint |
|---|---|
| id | bigserial PK |
| tenant_id | bigint FK tenants |
| message_id | bigint FK messages |
| gmail_draft_id | text nullable |
| thread_id | text required |
| to_addr | text required; derived from source conversation and editable only in Gmail after creation |
| subject, body_text | text required |
| status | text CHECK proposed, created, updated, discarded, sent_external |
| reason | text nullable |
| created_by | bigint FK users |
| created_at, updated_at | timestamptz |

One active local draft per `(tenant_id,message_id)`.

Valid statement example:

```json
{"periodStart":"2026-06-01","periodEnd":"2026-06-30","openingBalance":"1000.00","closingBalance":"900.00","lines":[{"lineNo":1,"postedOn":"2026-06-02","description":"Vendor","amount":"-100.00","balance":"900.00"}]}
```

Invalid example: closing balance `950.00` with the same opening/line data; it must become `unbalanced`, never `ready`.

## 7. Error Handling & Edge Cases

| Scenario | Status | Code | Response / Recovery |
|---|---:|---|---|
| Unsupported QB edition/operation | 422 | UNSUPPORTED_CAPABILITY | Show exact supported alternatives; hold item |
| Company identity mismatch | 409 | COMPANY_MISMATCH | Open correct company/reconnect; no write |
| Provider result uncertain | 202 | PROVIDER_RESULT_UNKNOWN | Hold and run duplicate/read-back probe |
| QBD connector offline | 202 | CONNECTOR_OFFLINE | Keep durable queued job; show last contact |
| QBD lease conflict | 409 | JOB_LEASED | Existing lease continues; no second dispatch |
| Statement duplicate | 200 | DUPLICATE_DOCUMENT | Return existing statement; insert nothing |
| Statement arithmetic mismatch | 422 | STATEMENT_UNBALANCED | Show equation and require review |
| Encrypted/unsupported statement | 422 | DOCUMENT_UNREADABLE | Ask user for unlocked PDF/CSV |
| Draft OAuth scope missing | 409 | GMAIL_COMPOSE_SCOPE_REQUIRED | Reconnect Gmail; keep proposed draft |
| Gmail draft create failure | 202 | DRAFT_RETRY | Retry with backoff; never send |
| Foreign tenant resource | 404 | NOT_FOUND | Reveal nothing |
| Insufficient role | 403 | FORBIDDEN | Explain permitted role |
| Missing proof on posting | 202 | PROOF_REQUIRED | Hold proposal |

Edge cases: multi-page statements, debit/credit separate columns, parentheses negatives, multiple accounts in one PDF, missing running balances, timezone/date ambiguity, duplicate pending/posted lines, reversed transactions, QBD status code errors, expired leases, QBWC replay, Gmail thread without Reply-To, oversized attachments, and provider attachment unsupported.

Retries: external reads/draft creation may retry three times with bounded exponential backoff. External creates do not blindly retry; they first perform duplicate/read-back resolution. QBD leases expire after five minutes and can be reclaimed only if no success response exists.

## 8. Performance & Scalability

- Target workload: 100 tenants, 10,000 documents/month, and 5 concurrent workers on one Postgres instance.
- Gmail poll and document creation p95 < 10 seconds excluding provider/LLM latency.
- API reads p95 < 750 ms for a tenant with 50,000 statement lines.
- Statement import of 5,000 lines completes < 30 seconds and uses one database transaction in batches.
- Provider job lease endpoint p95 < 500 ms; one active write lease per connection.
- Draft create/update p95 < 5 seconds excluding Gmail outage.
- Index all tenant/status/date and lease-expiry queries.
- New storage is bounded by existing attachment caps; provider responses store redacted structured results, not unbounded raw logs.
- No new paid service is introduced. Existing LLM/proof calls remain the only metered components.

## 9. Security & Compliance

- Sessions are HTTP-only, signed, expiring, and tenant-scoped. Role is read from current DB state per action.
- Owner: connect providers, approve/post, manage statement filing, create/update/discard drafts.
- Bookkeeper: review/correct/file statements and prepare drafts; cannot post.
- CPA: read-only.
- QBD SOAP jobs are scoped by connection and authenticated credentials; browser control uses human session/RBAC, not the QBWC shared password.
- Provider/OAuth secrets remain encrypted or DPAPI/platform protected; never stored in spec, Git, logs, provider job payload, or UI.
- Gmail OAuth requests read and compose/draft scopes only. The product interface contains no general send operation.
- Provider job response bodies are redacted and size-limited before persistence.
- Attachment and statement data are customer financial records. Cross-tenant isolation tests are mandatory.
- Audit rows are append-only product behavior; migrations do not alter/delete historical audit rows.
- Formal certification is not claimed. The operator remains responsible for privacy, retention, accounting review, and jurisdiction-specific obligations.

## 10. Testing Strategy

| Requirement | Named evidence |
|---|---|
| Capability truth | `provider-capabilities.test.ts`, UI capability contract |
| QBO/QBD contract parity | extend `connector-contract.test.ts`, `qbd-connector.test.ts` |
| Durable QBD jobs/restart/lease isolation | `provider-jobs.test.ts` with real test Postgres |
| Lost-response duplicate adoption | provider-specific failure injection tests |
| Existing invoice guarantees | complete current Vitest suite |
| Statement parsing/validation/dedup | `bank-statements.test.ts` with PDF/CSV fixtures |
| Statement RBAC/isolation/actions | `bank-statement-api.test.ts` |
| Gmail draft-only behavior | `gmail-drafts.test.ts`, `architecture-no-gmail-send.test.ts` |
| UI user flows | Playwright contract tests for statements/drafts/provider status |
| Boundary enforcement | `npm run lint:noleak` plus hostile `rg` assertions |
| Installer/config | PowerShell parser/SelfTest and env-contract tests |

Integration tests use real local Postgres and simulated Gmail/QBO/QBWC transports. `npm run verify:live` is reserved for disposable external accounts and must not run production writes or send messages.

## 11. Deployment & Rollout

Real deployment for this phase is the existing local Windows topology:

- Next.js UI on `127.0.0.1:3000`
- Node backend/workers/QBWC endpoint on `127.0.0.1:3001`
- PostgreSQL 16 through Docker Compose or installer-managed local service
- QBWC installed on the Windows machine that runs supported QuickBooks Desktop

Commands:

```powershell
docker compose up -d db
npm install
npm run migrate:up
npm run verify
.\deploy\install.ps1
```

New/changed environment names:

- `GMAIL_DRAFTS_ENABLED`
- `QB_DESKTOP_ENABLED`
- `QBWC_USERNAME`
- `QBWC_PASSWORD`
- `QB_DESKTOP_COMPANY_ID`
- `QB_DESKTOP_WRITE_ENABLED` (default false; live enablement owner-gated)
- `PROVIDER_JOB_LEASE_SECONDS`
- Existing Gmail, QBO, DB, encryption, SSO, session, LLM/proof variables remain.

Live verification:

- `GET http://127.0.0.1:3001/health` → 200 and DB true.
- `GET http://127.0.0.1:3000/login` → 200.
- Authenticated capability page matches connected provider.
- Disposable Gmail draft appears unsent.
- QBO sandbox/QBD test company contains one verified test bill.

Rollback: stop processes, deploy the previous Git commit/build, and run DOWN only if new tables contain no retained customer records. Otherwise leave additive tables and roll code back. Restore PostgreSQL from the documented backup if a migration/data verification fails.

## 12. API Documentation

`GET /api/provider-capabilities` — Auth: session, all roles
200: `{ connections:[{id,provider,edition,supported,capabilities,gaps,lastVerifiedAt}] }`

`GET /api/provider-jobs?connectionId=` — Auth: owner
200: `{ jobs:[{id,operation,status,attempts,errorCode,createdAt}] }`

`POST /api/provider-jobs/{id}/retry` — Auth: owner
Req: `{ reason }`
202 queued | 409 RESULT_UNKNOWN/NOT_RETRYABLE | 404

`GET /api/bank-statements?status=&from=&to=` — Auth: session
200: `{ statements:[...] }`

`GET /api/bank-statements/{id}` — Auth: session
200: `{ statement,lines,evidence,validation }` | 404

`POST /api/bank-statements/{id}/lines/{lineId}/match` — Auth: owner/bookkeeper
Req: `{ providerRef, reason }`
200 line | 400 VALIDATION | 403 | 404

`POST /api/bank-statements/{id}/lines/{lineId}/exclude` — Auth: owner/bookkeeper
Req: `{ reason }`
200 line | 400 | 403 | 404

`POST /api/bank-statements/{id}/file` — Auth: owner/bookkeeper
Req: `{ reason }`
200 `{status:"filed"}` | 409 STATEMENT_NOT_READY | 403 | 404

`GET /api/reply-drafts?messageId=` — Auth: session
200: `{ draft|null }`

`POST /api/reply-drafts` — Auth: owner/bookkeeper
Req: `{ messageId, subject, bodyText }`
201 `{id,gmailDraftId,status:"created",gmailUrl}` | 409 GMAIL_COMPOSE_SCOPE_REQUIRED | 403 | 404

`PATCH /api/reply-drafts/{id}` — Auth: owner/bookkeeper
Req: `{ subject?, bodyText? }`
200 draft | 409 DRAFT_ALREADY_SENT | 403 | 404

`DELETE /api/reply-drafts/{id}` — Auth: owner/bookkeeper
200 `{status:"discarded"}` | 403 | 404

No `/send` endpoint exists for reply drafts. Existing locked gatekeeper forwarding remains a separate internal capture workflow.

## 13. Database Migrations

UP migration:

```sql
CREATE TABLE accounting_documents (...columns and constraints from §6...);
CREATE UNIQUE INDEX accounting_documents_tenant_hash_kind_uq
  ON accounting_documents(tenant_id, sha256, kind);
CREATE INDEX accounting_documents_tenant_status_idx
  ON accounting_documents(tenant_id, status, created_at DESC);

CREATE TABLE bank_statements (...columns and constraints from §6...);
CREATE INDEX bank_statements_tenant_status_period_idx
  ON bank_statements(tenant_id, status, period_end DESC);

CREATE TABLE bank_statement_lines (...columns and constraints from §6...);
CREATE UNIQUE INDEX bank_statement_lines_statement_line_uq
  ON bank_statement_lines(statement_id, line_no);
CREATE UNIQUE INDEX bank_statement_lines_tenant_fingerprint_uq
  ON bank_statement_lines(tenant_id, fingerprint);

CREATE TABLE provider_jobs (...columns and constraints from §6...);
CREATE UNIQUE INDEX provider_jobs_idempotent_uq
  ON provider_jobs(tenant_id, connection_id, idempotency_key, operation);
CREATE INDEX provider_jobs_lease_idx
  ON provider_jobs(connection_id, status, lease_expires_at, created_at);

CREATE TABLE reply_drafts (...columns and constraints from §6...);
CREATE UNIQUE INDEX reply_drafts_one_active_per_message_uq
  ON reply_drafts(tenant_id,message_id)
  WHERE status IN ('proposed','created','updated');
```

DOWN migration is allowed only after verification queries return zero rows for all five new tables:

```sql
DROP TABLE reply_drafts;
DROP TABLE provider_jobs;
DROP TABLE bank_statement_lines;
DROP TABLE bank_statements;
DROP TABLE accounting_documents;
```

Verification query:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema='public'
AND table_name IN (
  'accounting_documents','bank_statements','bank_statement_lines',
  'provider_jobs','reply_drafts'
)
ORDER BY table_name;
```

Expected: exactly five rows. Migrations are tested UP → DOWN → UP against a disposable database. No production DOWN runs without reference and row-count checks.

## 14. Known Limitations, Open Questions & Future Work

Known limitations:

- QuickBooks support is limited by documented Intuit integration surfaces and per-edition capabilities.
- QBD requires Windows, a running compatible QuickBooks Desktop company, and Web Connector polling.
- Bank statements without reliable text/layout may require manual correction or CSV upload.
- Statement filing is evidence organization, not automatic bank-feed reconciliation or journal-entry generation.
- Gmail drafts can be sent/edited outside AP Hub; local state is a projection refreshed on read.
- Production provider enablement and live external certification require owner approval.

Open questions: none. The capability matrix resolves edition variability at runtime without blocking the build.

Future work: additional QBD transaction types after bill contract certification; bank-feed reconciliation; CSV/OFX import adapters; optional provider connectors outside QuickBooks; production rollout.

## Risks

1. Duplicate external accounting writes after ambiguous timeouts — mitigate with stable idempotency, duplicate probe, read-back adoption, and held uncertainty.
2. QBD durability/tenant leakage — mitigate with PostgreSQL leases and scoped uniqueness.
3. False “any edition” marketing — mitigate with executable capability matrix and visible gaps.
4. Plausible but incorrect statement extraction — mitigate with arithmetic validation and mandatory review.
5. Gmail scope creep into send — mitigate with a draft-only interface and architecture test.
6. Local tests diverge from provider behavior — mitigate with disposable live certification before production.

## 15. Glossary

- Capability matrix: executable declaration of operations and fields a specific provider/edition supports.
- QBO: QuickBooks Online via Intuit REST Accounting API.
- QBD: supported Windows QuickBooks Desktop via QuickBooks Web Connector and qbXML.
- QBWC: QuickBooks Web Connector, a Windows pull client that calls AP Hub’s SOAP endpoint.
- Provider job: durable asynchronous work item leased to an accounting connector.
- Result unknown: external write may have succeeded, so blind retry is forbidden.
- Filing: storing a reviewed statement and its dispositions as evidence; not creating GL entries.

## 16. Monitoring & Metrics

- Existing `/health` reports DB/worker state.
- Add provider connection/job health: queued oldest age, expired leases, last QBWC contact, failed/held counts.
- Add statement counts by status and draft failures by code to structured logs.
- Alert through existing operator channel when:
  - oldest QBD queued write exceeds 30 minutes while connector is expected online;
  - a provider result remains unknown > 15 minutes;
  - statement extraction failure rate exceeds 20% over 20 documents;
  - Gmail compose scope fails three consecutive attempts.
- Success query reports document routing accuracy from reviewed corrections, duplicate posting count, provider job outcomes, and application send count (must remain zero).
- Do not add a new monitoring vendor.

## 17. Alternative Designs Considered

1. Treat every QuickBooks product as one identical API. Rejected because Desktop and Online have different transport, lifecycle, capabilities, and idempotency behavior.
2. Keep QBD jobs in memory. Rejected because restarts and asynchronous polling make lost/duplicated work unavoidable.
3. Send email directly after draft approval. Rejected because the owner explicitly requires human sending and Gmail itself is the safest send surface.
4. Convert every statement line into a journal entry. Rejected because classification uncertainty and edition-specific accounting rules create unacceptable book-corruption risk.

## 18. Build Phases & Final Checklist

### Build Phases

1. **Schema and contracts:** add document/statement/provider-job/draft schema, capability model, migrations, and contract tests.
2. **QuickBooks Desktop posting:** replace in-memory ownership with durable jobs; implement bill qbXML, identity, lease, response parsing, duplicate/read-back, audit, and simulated QBWC tests.
3. **Bank statements:** implement classification routing, extraction normalization, validation, dedup, review actions, filing, APIs, and fixtures.
4. **Gmail drafts:** add OAuth compose scope, draft-only adapter/service/storage, APIs, audit, and no-send architecture tests.
5. **Owner product surface:** add provider capability/status, statements, and draft-review UI with RBAC and tenant isolation.
6. **Hardening and certification harness:** installer/env updates, metrics, backup/migration proof, hostile source scans, full verification, and disposable live-test instructions.

Final checklist:

- [ ] All additive migrations pass UP → DOWN → UP on disposable DB.
- [ ] QBO and QBD bill connectors pass shared contract tests.
- [ ] QBD durable restart, lease, identity, and ambiguity tests pass.
- [ ] Statement happy/edge/failure/RBAC/isolation tests pass.
- [ ] Gmail draft create/update/discard and no-send tests pass.
- [ ] UI contract tests cover owner, bookkeeper, CPA, and unauthenticated states.
- [ ] Existing invoice/auth/proof/audit tests remain green.
- [ ] `npm run verify`, broker tests, PowerShell parsing, Compose config, and secret scan pass.
- [ ] Live external checks remain explicitly NOT VERIFIED until disposable-account execution.
- [ ] Whole-build `spec-vs-build-brutal-audit` runs against this file after implementation.

The building agent must:
- [ ] Read the full spec + Architecture Grounding Summary before writing code
- [ ] Produce a plan/file-tree first — not code
- [ ] Test every "must not break" item before marking any phase complete
- [ ] Treat the Definition of Done as the ONLY completion signal
- [ ] Stop and escalate if a must-not-break guarantee is at risk — never ship around it
- [ ] Attach a concrete artifact per done condition (test output, HTTP log, DB row)
- [ ] Never mark done on local-only verification — deployed-environment proof required
