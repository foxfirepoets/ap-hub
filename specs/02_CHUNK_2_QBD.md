# CHUNK_2_QBD: Deliver durable QuickBooks Desktop bill posting

## Summary

This chunk turns the existing QBD protocol seam into a restart-safe connector for supported Windows Desktop editions. It owns capability verification, durable QBWC leasing, bill qbXML, response parsing, duplicate adoption, read-back, and audit behavior.

## Acceptance Criteria

- [ ] QBD work is stored in `provider_jobs`; the process-memory pending queue is not the source of truth.
- [ ] One tenant/connection lease can be held at a time and expired leases recover safely.
- [ ] Company identity and edition capability are verified before a write request is leased.
- [ ] BillAdd response parsing records external ID/revision; lost responses trigger query/adoption before retry.
- [ ] QBO and QBD satisfy the shared posting contract while unsupported editions/operations hold visibly.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|---|---|---|
| POST | `/qbwc` | Existing SOAP pull endpoint backed by durable jobs |
| GET | `/api/provider-capabilities` | Tenant-scoped provider/edition capability report |
| GET | `/api/provider-jobs` | Owner-visible job status |
| POST | `/api/provider-jobs/:id/retry` | Safe owner retry after recovery checks |

## Database Changes

Uses `provider_jobs` from CHUNK_1; no new schema.

## Test Scenarios

- **Happy path**: simulated QBWC leases, posts, responds, reads back, and reconciles one bill.
- **Edge case**: restart between enqueue and QBWC poll preserves work.
- **Failure case**: mismatched company, unsupported edition, or unknown result holds without duplicate create.
- **Integration**: existing proposal approval routes to QBO or QBD connector by connection.

## Dependencies

- **Requires**: CHUNK_1_CONTRACTS
- **Blocks**: CHUNK_5_PRODUCT, CHUNK_6_HARDENING

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_2_QBD</promise>
