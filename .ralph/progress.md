# Progress Log (append-only)

Project: ap-hub-multi-edition-accounting-intake
Initialized: 2026-07-24
Total chunks: 6

## Log

(no entries yet)

## Planning - 2026-07-24
- Accepted primary user: any small-to-medium-sized business owner.
- Created `IMPLEMENTATION_PLAN.md` with 13 independently verifiable tasks across all six chunks in dependency order.
- Every task names concrete validation evidence and preserves the provider-write, tenant-isolation, proof-gate, and Gmail no-send guardrails.
<promise>PLANNING COMPLETE</promise>

## CHUNK_1_SCHEMA - 2026-07-24
- Added `008_accounting_intake` UP/DOWN migration for all five durable intake tables.
- Tenant ownership is enforced by composite foreign keys for messages, attachments, documents, statements, connections, proposals, and users.
- Added lifecycle/status checks, period/confidence/lease/attempt checks, query indexes, document/line/job idempotency, and one-active-draft uniqueness.
- DOWN refuses retained financial rows transactionally and leaves migration history intact on refusal.
- Added real disposable-PostgreSQL coverage for schema presence, valid inserts, SQLSTATE `23503` tenant rejection, `23514` check rejection, `23505` duplicate rejection, retained-row DOWN refusal, and empty UP -> DOWN -> UP.
- Targeted evidence: `npx vitest run test/accounting-intake-migration.test.ts` -> 1 file passed, 1 test passed.
- Repository evidence: `npm run verify` -> lint PASS; boundary scan PASS; typecheck PASS; 49 files / 367 tests PASS; Next.js production build PASS; Playwright 8/8 PASS.
<promise>CHUNK TASK COMPLETE: CHUNK_1_SCHEMA</promise>

## CBV Truth Audit — CHUNK_1_SCHEMA
- Source: commit `5559df10f41511dfa5c3bf4a5cd4cab6fff9d4e0`
- Database proof: disposable PostgreSQL UP, constraint checks, retained-row DOWN refusal, empty DOWN, and UP passed.
- Repository proof: `npm run verify` exited 0; 49 files / 367 tests and 8 UI contracts passed.
- Verdict: GREEN_COMPLETE for this task. Live external integrations are N/A.

## CHUNK_1_TYPES - 2026-07-24
- Added provider-neutral contracts for accounting documents, statement facts/lines, provider capabilities/jobs, and reply-draft projections.
- Added tenant-scoped repositories using the existing `scopedQuery` boundary; core contains no provider writer imports or provider calls.
- Runtime contract validation rejects invalid document, statement, job-operation, and draft lifecycle values before database access.
- Repository failures preserve PostgreSQL duplicate-key (`23505`) and foreign-tenant-reference (`23503`) evidence for callers.
- Targeted evidence: `npx vitest run test/accounting-intake-contracts.test.ts` -> 1 file passed, 5 tests passed.
- Boundary evidence: `npm run lint:noleak` -> no provider/OS boundary leaks.
- Repository evidence: `npm run verify` -> lint PASS; boundary scan PASS; typecheck PASS; 50 files / 372 tests PASS; Next.js production build PASS; Playwright 8/8 PASS.
<promise>CHUNK TASK COMPLETE: CHUNK_1_TYPES</promise>
## CHUNK_1_TYPES — independent truth audit

- Commit: `50d32b8a045a2012755e23740c828438735c9b30`
- Verdict: GREEN
- Independent validation: `npm run verify` exited 0.
- Evidence: ESLint, secret-leak scan, TypeScript, 50 Vitest files / 372 tests, Next.js production build, and 8 Playwright contract flows passed.
- Boundary evidence: provider-neutral accounting contracts and tenant-scoped repository behavior are covered by `test/accounting-intake-contracts.test.ts`.
- Live external proof: N/A for this local contract-only task.

## CHUNK_2_CAPABILITIES - 2026-07-24
- Added an executable, fail-closed QuickBooks capability matrix for certified QBO editions and Windows QBD Pro, Premier, and Enterprise.
- Every connection exposes operation-level results for company verification, query, bill posting, read-back, and attachments, plus explicit unsupported fields.
- Incompatible providers, QBO Self-Employed/unknown editions, QBD Mac/unknown editions, non-Windows Desktop connections, and inactive connections return `supported:false` with an actionable remediation reason.
- Added tenant-scoped `GET /api/provider-capabilities`; the session tenant is the only query authority and owner, bookkeeper, and CPA reads are explicitly allowed while unauthenticated/unknown roles are rejected.
- Targeted evidence: `npx vitest run test/provider-capabilities.test.ts` -> 1 file passed, 8 tests passed.
- Repository evidence: `npm run verify` -> lint PASS; boundary scan PASS; typecheck PASS; 51 files / 380 tests PASS; Next.js production build PASS with the new API route; Playwright 8/8 PASS.
- Live external proof: N/A for this read-only capability-truth task.
<promise>CHUNK TASK COMPLETE: CHUNK_2_CAPABILITIES</promise>
## CHUNK_2_CAPABILITIES — independent truth audit

- Commit: `33e0577cbd1c7645eeb01db13ccccc501841c4f6`
- Verdict: GREEN
- Independent validation: `npm run verify` exited 0.
- Evidence: ESLint, secret-leak scan, TypeScript, 51 Vitest files / 380 tests, Next.js production build, and 8 Playwright contract flows passed.
- Boundary evidence: capability tests cover QBO, supported Windows QBD Pro/Premier/Enterprise, incompatible editions/platforms/providers, RBAC, and tenant isolation.
- Live external proof: N/A; this task declares certified local capability truth and performs no provider writes.

## CHUNK_2_DURABLE_JOBS - 2026-07-24
- Added a PostgreSQL-authoritative QBD job service with deterministic SHA-256 idempotency keys and insert deduplication that survives service reconstruction.
- Added transaction/advisory-lock leasing that permits one active lease per connection, scopes every operation by tenant and connection, and safely recovers expired pre-send leases.
- Expired sent jobs move to `held/UNCERTAIN_OUTCOME`; retries are refused until the next posting-contract task supplies provider query/adoption evidence.
- QBD company identity is checked against the connection record before any job is leased; mismatches visibly hold all queued connection work.
- Added owner-only tenant-scoped `GET /api/provider-jobs` and `POST /api/provider-jobs/:id/retry`; bookkeeper/CPA and foreign-tenant access fail closed.
- Targeted evidence: `npx vitest run test/provider-durable-jobs.test.ts` -> 1 file passed, 5 tests passed.
- Paired cleanup evidence: migration + durable-job suites -> 2 files passed, 6 tests passed.
- Repository evidence: `npm run verify` -> lint PASS; boundary scan PASS; typecheck PASS; 52 files / 385 tests PASS; Next.js production build PASS; Playwright 8/8 PASS.
- No provider calls, production writes, or real-company writes were performed.
<promise>CHUNK TASK COMPLETE: CHUNK_2_DURABLE_JOBS</promise>
## CHUNK_2_DURABLE_JOBS — independent truth audit

- Commit: `e016b7e385ef289b57ed202b3a561eb1e510f847`
- Verdict: GREEN
- Independent validation: `npm run verify` exited 0.
- Evidence: ESLint, secret-leak scan, TypeScript, 52 Vitest files / 385 tests, Next.js production build, and 8 Playwright contract flows passed.
- Database evidence: restart persistence, per-connection lease exclusion, tenant isolation, expired-lease recovery, company mismatch hold, and uncertain-result retry refusal passed against PostgreSQL.
- Live external proof: N/A; no provider or production writes were performed.

## CHUNK_2_POSTING_CONTRACT - 2026-07-24
- Added a QBD `AccountingConnector` implementation behind the same provider-neutral posting boundary used by QBO.
- Added BillQuery qbXML generation and strict BillRet response parsing for external TxnID, EditSequence, vendor, reference, date, and amount; provider errors and incomplete identities fail visibly.
- QBD duplicate probes use vendor/reference/date and authoritative read-back uses TxnID. Unsupported attachments, currency, and dimensions are declared and never silently discarded.
- Added durable known-result completion, known-failure, uncertain-outcome hold, and provider-evidence adoption transitions to `provider_jobs`.
- Fixed posting projections to use the actual provider in reconciliation/audit and corrected the timeout-adoption entity-type projection.
- Simulated QBWC happy path performed pre-create query, exactly one BillAdd, read-back, reconciliation, and provider-labeled audit through `postOnce`.
- Lost-response simulation proved exactly one provider create followed by query/adoption; malformed and error qbXML fixtures fail closed.
- Targeted evidence: QBD/shared posting + QBO connector + existing posting + durable job suites -> 4 files / 38 tests passed.
- Repository evidence: `npm run verify` -> lint PASS; boundary scan PASS; typecheck PASS; 53 files / 390 tests PASS; Next.js production build PASS; Playwright 8/8 PASS.
- Safety evidence: all provider exchanges were injected simulations; no credentials, live providers, production settings, or real-company writes were used or enabled.
<promise>CHUNK TASK COMPLETE: CHUNK_2_POSTING_CONTRACT</promise>
<promise>CHUNK COMPLETE: CHUNK_2_QBD</promise>
## CHUNK_2_POSTING_CONTRACT — independent truth audit

- Commit: `a1ce78c10c18d669fba3d667dca6f60e414f1b66`
- Verdict: GREEN
- Independent validation: `npm run verify` exited 0.
- Evidence: ESLint, secret-leak scan, TypeScript, 53 Vitest files / 390 tests, Next.js production build, and 8 Playwright contract flows passed.
- Posting evidence: simulated QBD happy path, lost-response adoption with exactly one create, strict qbXML parsing, durable uncertain-result adoption, QBO regressions, reconciliation/audit projection, and proof-gate fail-closed behavior passed.
- Live external proof: NOT VERIFIED by design; no live QBO/QBD calls or production writes.

## CHUNK_3_INGEST - 2026-07-24
- Extended canonical attachment routing to distinguish `invoice`, `bank_statement`, and fail-closed `unknown`; unknowns are held and statements cannot enter the invoice extractor.
- Preserved the existing invoice path: recognized invoice attachments enqueue exactly one existing `extract` job.
- Added deterministic exact-cent normalization for statement headers and ordered source lines, including commas, currency symbols, and parentheses negatives without floating-point arithmetic.
- Added one-transaction persistence for the canonical document, statement header, and every ordered line; pre-routed statement documents are adopted rather than duplicated.
- Duplicate files return the existing statement without inserts; duplicate lines and invalid periods/dates/money fail before accounting writes.
- Arithmetic imbalance persists source evidence as `unbalanced`, holds the canonical document with `STATEMENT_UNBALANCED`, and exposes the exact failing equation.
- Encrypted/unreadable input persists only a held source document with a named reason and creates zero statement facts or lines.
- Fixture evidence: balanced, multi-page, missing-running-balance, parentheses-negative, duplicate-line/document, imbalanced, encrypted, and existing-invoice cases.
- Targeted evidence: `npx vitest run test/bank-statements.test.ts` -> 1 file / 11 tests passed.
- Regression evidence: statement, classification, existing invoice extraction, and attachment-infra suites -> 4 files / 36 tests passed before the final routing assertion; the full gate includes all 11 statement tests.
- Repository evidence: `npm run verify` exited 0 -> lint PASS; boundary scan PASS; typecheck PASS; complete Vitest suite PASS; Next.js production build PASS; Playwright 8/8 PASS.
- Safety evidence: no provider call, external accounting write, email action, or live credential was used.
<promise>CHUNK TASK COMPLETE: CHUNK_3_INGEST</promise>
## CHUNK_3_INGEST — independent truth audit

- Commit: `722da3b17cae6032f180c57441788a0e6255e90c`
- Verdict: GREEN
- Independent validation: `npm run verify` exited 0.
- Evidence: ESLint, secret-leak scan, TypeScript, 54 Vitest files / 401 tests, Next.js production build, and 8 Playwright contract flows passed.
- Ingestion evidence: 11 statement fixtures cover balance, pagination, missing running balance, negative notation, duplicates, imbalance, encryption, and unchanged invoice routing with transactional row assertions.
- Live external proof: N/A; no provider writes or email actions.

## CHUNK_3_REVIEW_API - 2026-07-24
- Added tenant-scoped statement queue and detail reads for owner, bookkeeper, and read-only CPA roles.
- Added owner/bookkeeper match, exclude-with-reason, allowlisted fact correction, and evidence-filing actions with human audit rows.
- Foreign statement/line identifiers fail as 404 without mutation or existence disclosure; CPA mutations fail 403 and unauthenticated reads fail 401.
- Filing requires every line to be matched or excluded and rejects held/unbalanced statements.
- Filing updates only `bank_statements` and `accounting_documents`; behavioral DB assertions prove unchanged `proposals`, `provider_jobs`, `postings_ap`, and `reconciliation` counts.
- A hostile static test rejects connector/posting/provider-writer imports and transaction/job INSERT statements in the review module.
- Targeted evidence: `npx vitest run test/bank-statement-api.test.ts` -> 1 file / 7 tests passed.
- Repository evidence: `npm run verify` exited 0 -> lint PASS; boundary scan PASS; typecheck PASS; 55 Vitest files / 408 tests PASS; Next.js production build PASS; Playwright 8/8 PASS.
- Live external proof: N/A; statement filing is local evidence organization and performed no provider call or accounting write.
<promise>CHUNK TASK COMPLETE: CHUNK_3_REVIEW_API</promise>
<promise>CHUNK COMPLETE: CHUNK_3_STATEMENTS</promise>
## CHUNK_3_REVIEW_API — independent truth audit

- Commit: `b46340260781b65c9be6ce93a5d2eb7c99f183ed`
- Verdict: GREEN
- Independent validation: `npm run verify` exited 0.
- Evidence: ESLint, secret-leak scan, TypeScript, 55 Vitest files / 408 tests, Next.js production build, and 8 Playwright contract flows passed.
- Safety evidence: queue/detail, match, exclude, correct and file RBAC/tenant tests passed; filing changes zero proposals/provider jobs/postings/reconciliation rows and a static invariant forbids posting imports/inserts.
- Live external proof: N/A; no provider calls or writes.

## CHUNK_4_GMAIL_ADAPTER - 2026-07-24
- Added optional least-privilege Gmail OAuth compose access alongside existing readonly
  access, gated by `GMAIL_DRAFTS_ENABLED` with incremental reconnect authorization.
- Added a provider-bound draft client with create, update, read-status, and discard
  operations only. It derives the recipient from source Reply-To/From, rejects header
  injection, and requires every provider result/mutation to stay in the source thread.
- Added bounded three-attempt retry for transient provider failures and explicit
  reconnect/auth errors for missing scope or rejected tokens.
- The draft boundary has no transmission method or Gmail message-send call; runtime
  export and static source assertions enforce this invariant.
- Existing locked gatekeeper forwarding code was not modified; gatekeeper, lockdown,
  and digest regression suites remain green.
- Targeted evidence: 2 files / 10 draft and OAuth tests passed; 3 files / 24
  gatekeeper/lockdown/digest tests passed.
- Repository evidence: `npm run verify` exited 0 -> lint PASS; boundary scan PASS;
  typecheck PASS; 56 Vitest files / 416 tests PASS; Next.js production build PASS;
  Playwright 8/8 PASS.
- Live external proof: NOT VERIFIED by design; no Gmail draft was created and no email
  was transmitted.
<promise>CHUNK TASK COMPLETE: CHUNK_4_GMAIL_ADAPTER</promise>
