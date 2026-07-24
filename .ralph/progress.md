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
