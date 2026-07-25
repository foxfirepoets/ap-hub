# CHUNK_3_STATEMENTS: Build the reviewed bank-statement workflow

## Summary

This chunk routes statement attachments into a source-backed statement domain. It normalizes headers and lines, proves arithmetic, prevents duplicates, supports human dispositions, and files evidence without silently creating GL transactions.

## Acceptance Criteria

- [ ] Document routing distinguishes invoice, bank statement, and unknown with a held fallback.
- [ ] Statement import writes one header plus ordered immutable lines transactionally.
- [ ] Duplicate files/lines and balance/period errors are detected deterministically.
- [ ] Owner/bookkeeper can match, exclude with reason, correct with audit, and file; CPA is read-only.
- [ ] Filing never creates an accounting transaction without a separate approved proposal.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|---|---|---|
| GET | `/api/bank-statements` | Tenant-scoped statement queue |
| GET | `/api/bank-statements/:id` | Statement, lines, validation, evidence |
| POST | `/api/bank-statements/:id/lines/:lineId/match` | Record provider match |
| POST | `/api/bank-statements/:id/lines/:lineId/exclude` | Exclude with reason |
| POST | `/api/bank-statements/:id/file` | File a ready reviewed statement |

## Database Changes

Uses `accounting_documents`, `bank_statements`, and `bank_statement_lines` from CHUNK_1; no new schema.

## Test Scenarios

- **Happy path**: balanced fixture imports, reviews, and files with source evidence.
- **Edge case**: multi-page, missing-running-balance, parentheses-negative, and duplicate fixtures.
- **Failure case**: imbalance/unreadable file is held and cannot be filed.
- **Integration**: invoice fixtures still route to the existing pipeline unchanged.

## Dependencies

- **Requires**: CHUNK_1_CONTRACTS
- **Blocks**: CHUNK_5_PRODUCT, CHUNK_6_HARDENING

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_3_STATEMENTS</promise>
