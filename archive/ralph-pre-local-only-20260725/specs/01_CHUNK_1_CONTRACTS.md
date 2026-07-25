# CHUNK_1_CONTRACTS: Establish durable accounting-document contracts

## Summary

This chunk adds the additive schema and TypeScript contracts that every later capability uses. It makes document routing, statements, provider work, Gmail drafts, and edition capabilities explicit without changing live external behavior.

## Acceptance Criteria

- [ ] Migration creates `accounting_documents`, statement tables, `provider_jobs`, and `reply_drafts` with tenant keys, checks, indexes, and idempotency constraints.
- [ ] UP → DOWN → UP succeeds on a disposable database and DOWN refuses retained rows.
- [ ] Canonical types define statement facts, provider capabilities, provider jobs, and reply drafts without provider naming in core.
- [ ] Existing schema, auth, invoice, proof, and posting behavior remains compatible.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

`AccountingDocument`, `BankStatement`, `BankStatementLine`, `ProviderJob`, `ReplyDraft`, and edition capability contracts. No HTTP endpoints in this chunk.

## Database Changes

- `accounting_documents`: canonical source-document lifecycle (NEW)
- `bank_statements` and `bank_statement_lines`: immutable statement facts and review state (NEW, one statement-domain boundary)
- `provider_jobs`: durable external-provider work (NEW)
- `reply_drafts`: Gmail draft projection (NEW)

## Test Scenarios

- **Happy path**: migrate up and create valid tenant-scoped rows.
- **Edge case**: duplicate document/job/draft keys are rejected.
- **Failure case**: invalid status or cross-tenant FK combination is rejected.
- **Integration**: generated types and rows are consumable by chunks 2–5.

## Dependencies

- **Requires**: None
- **Blocks**: CHUNK_2_QBD, CHUNK_3_STATEMENTS, CHUNK_4_DRAFTS, CHUNK_5_PRODUCT

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_1_CONTRACTS</promise>
