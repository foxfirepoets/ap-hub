# CHUNK_5_PRODUCT: Expose the owner accounting workspace

## Summary

This chunk makes provider capabilities, QBD job status, statement review, and Gmail drafts usable from the existing exception-driven UI. It preserves the current role model and tenant-scoped service boundary.

## Acceptance Criteria

- [ ] Settings displays connected QuickBooks provider, detected edition, supported operations, gaps, and health.
- [ ] Statement queue/detail supports review, matching, exclusion, filing, and source evidence.
- [ ] Exception detail supports prepare/edit/open-in-Gmail draft flow without a send button.
- [ ] Owner/bookkeeper/CPA/unauthenticated UI and API permissions match the spec.
- [ ] Every new route has cross-tenant isolation coverage and friendly recovery states.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

Consumes endpoints from CHUNK_2_QBD, CHUNK_3_STATEMENTS, and CHUNK_4_DRAFTS.

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: owner reviews a statement, files it, prepares a draft, and sees provider status.
- **Edge case**: offline QBD and missing Gmail scope show actionable states.
- **Failure case**: CPA mutation and cross-tenant navigation are refused.
- **Integration**: existing Today/Exceptions/Transactions flows remain green.

## Dependencies

- **Requires**: CHUNK_2_QBD, CHUNK_3_STATEMENTS, CHUNK_4_DRAFTS
- **Blocks**: CHUNK_6_HARDENING

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_5_PRODUCT</promise>
