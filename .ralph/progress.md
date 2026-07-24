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
