# Implementation Plan — Multi-Edition Accounting Intake

Execute tasks in order. Each checkbox is one independently verifiable Ralph iteration. A task is complete only when its named evidence is captured in `.ralph/progress.md` and the repository gate from `AGENTS.md` remains green.

## CHUNK_1_CONTRACTS — Durable domain foundation

- [x] CHUNK_1_SCHEMA — Add one reversible SQL migration for `accounting_documents`, `bank_statements`, `bank_statement_lines`, `provider_jobs`, and `reply_drafts`, including tenant-scoped foreign keys, status checks, query indexes, idempotency constraints, and a DOWN refusal when retained rows exist. Evidence: disposable PostgreSQL UP → schema/constraint assertions → DOWN → UP transcript, migration tests, and `npm run verify`.

- [x] CHUNK_1_TYPES — Add provider-neutral TypeScript contracts and repositories for accounting documents, statement facts/lines, provider capabilities/jobs, and reply drafts without importing QBO, qbXML, or Gmail provider writers into core services. Evidence: contract/repository unit tests covering valid rows, duplicate keys, invalid status, and foreign-tenant references; hostile boundary scan; `npm run verify`.

## CHUNK_2_QBD — QuickBooks capability truth and durable posting

- [x] CHUNK_2_CAPABILITIES — Implement an executable capability matrix and tenant-scoped `GET /api/provider-capabilities` that identifies QBO and supported Windows QBD editions/operations while returning `supported:false` with an exact reason for unsupported products or fields. Evidence: provider capability unit/API tests for QBO, QBD Pro/Premier/Enterprise, incompatible editions, RBAC, and cross-tenant access; `npm run verify`.

- [x] CHUNK_2_DURABLE_JOBS — Replace the QBD process-memory queue with PostgreSQL `provider_jobs`, stable idempotency keys, one active write lease per connection, lease expiry recovery, company-identity verification, and owner-only job status/retry APIs. Evidence: real-test-Postgres tests proving restart persistence, connection/tenant lease isolation, expired-lease recovery, identity mismatch hold, retry refusal for uncertain results, and `npm run verify`.

- [x] CHUNK_2_POSTING_CONTRACT — Route approved bills through the existing provider-neutral posting boundary, implementing QBD BillAdd response parsing, provider duplicate query/read-back adoption, reconciliation/audit projection, and shared QBO/QBD connector contract behavior without enabling production or real-company writes in automation. Evidence: simulated QBWC happy path, lost-response adoption with exactly one provider create, replay/error fixtures, QBO sandbox-adapter contract tests, proof-gate regression tests, and `npm run verify`.

## CHUNK_3_STATEMENTS — Reviewed bank-statement workflow

- [x] CHUNK_3_INGEST — Extend attachment routing to classify invoice, bank statement, or unknown; normalize supported statement fixtures into one transactional header plus ordered immutable lines; and deterministically detect duplicate documents/lines, period errors, arithmetic imbalance, and unreadable/encrypted input. Evidence: fixture tests for balanced, multi-page, missing-running-balance, parentheses-negative, duplicate, imbalanced, encrypted, and existing invoice cases; database row assertions; `npm run verify`.

- [x] CHUNK_3_REVIEW_API — Implement tenant-scoped statement queue/detail, match, exclude-with-reason, audited correction, and filing services/routes with owner/bookkeeper mutation rights, CPA read-only behavior, and a structural guarantee that filing alone creates no accounting transaction. Evidence: API/service tests for happy path, validation failures, RBAC, foreign IDs, audit rows, zero provider writes during filing, and `npm run verify`.

## CHUNK_4_DRAFTS — Gmail drafts with human-only sending

- [x] CHUNK_4_GMAIL_ADAPTER — Extend Gmail OAuth/reconnect handling for least-privilege compose access and implement provider-bound create, update, read-status, and discard draft operations in the source thread while keeping locked gatekeeper forwarding separate. Evidence: simulated Gmail adapter tests for thread/recipient derivation, missing scope, token failure/retry, provider IDs, discard, and unchanged gatekeeper behavior; `npm run verify`.

- [x] CHUNK_4_DRAFT_API — Implement tenant-scoped reply-draft persistence and GET/POST/PATCH/DELETE routes with owner/bookkeeper mutation, CPA read-only access, append-only audit evidence, and no application send operation. Evidence: draft lifecycle, already-sent projection, RBAC, foreign-resource, and audit tests plus static/runtime architecture tests proving the reply-draft surface cannot invoke Gmail send; `npm run verify`.

## CHUNK_5_PRODUCT — SMB-owner accounting workspace

- [x] CHUNK_5_PROVIDER_STATEMENT_UI — Add settings capability/health presentation and statement queue/detail workflows for evidence review, matching, exclusion, corrections, and filing, with clear offline, unsupported, held, and validation recovery states. Evidence: Playwright UI contracts for owner/bookkeeper/CPA/unauthenticated roles, cross-tenant API contracts, existing Today/Exceptions/Transactions regression coverage, screenshots recorded in progress, and `npm run verify`.

- [x] CHUNK_5_DRAFT_UI — Add exception-detail draft preparation/edit/update/discard and open-in-Gmail behavior without a send button, including missing-compose-scope recovery and read-only CPA presentation. Evidence: Playwright UI contracts for draft lifecycle and each role, hostile DOM/source assertion that no reply-draft send action exists, source-thread link assertion, and `npm run verify`.

## CHUNK_6_HARDENING — Operational and adversarial proof

- [ ] CHUNK_6_OPERATIONS — Align config, `.env.example`, installers, health/diagnostics, monitoring logs, backup/restore, migration rollback, and disposable live-certification instructions with QBD durable writes, Gmail drafts, and statement processing while retaining safe defaults. Evidence: env-contract tests, PowerShell parser/SelfTest output, `docker compose config`, secret-shaped diff scan, backup/restore rehearsal on a disposable DB, health/metric assertions, and `npm run verify`.

- [ ] CHUNK_6_RELEASE_PROOF — Run the complete adversarial release gate and record artifacts for must-not-break guarantees, capability truth, duplicate prevention, tenant isolation, statement correctness, Gmail no-send, existing invoice/auth/proof/audit behavior, broker tests, build outputs, and separately labeled disposable-account checks. Evidence: zero unchecked local acceptance criteria, `npm run verify`, broker test transcript, hostile `rg`/boundary scans, whole-build `spec-vs-build-brutal-audit`, and deployed-environment HTTP/DB/screenshot/log artifacts; external items remain explicitly `NOT VERIFIED` unless actually observed.

## Completed

Move a task here only after its checkbox is checked and its validation evidence is appended to `.ralph/progress.md`.

## Discovered Issues

Record newly discovered work here before scheduling it. Do not silently expand a task or bypass `.ralph/guardrails.md`.
