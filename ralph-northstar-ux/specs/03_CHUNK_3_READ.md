# CHUNK_3_READ: Serve read-only Today, Exceptions, Transactions, Evidence, and Audit data

## Summary

Builds the read API that projects the existing pipeline tables into the UI's views, every query scoped to the session tenant. Reuses the `v_proposal_review` view for proposal review. Provides the Evidence endpoint that returns the full proof chain (email, attachment+sha256, extracted fields, confidence, prior rule, QBO link). No writes happen here.

## Acceptance Criteria

- [ ] `GET /api/today` returns digest + counts whose numbers equal SELECT-derived counts on the tenant's `exceptions`/`proposals`/`postings`.
- [ ] `GET /api/exceptions` and `GET /api/exceptions/:id` return only the session tenant's rows.
- [ ] `GET /api/transactions` and `/:id` list prepared/posted/held/reconciled items with status.
- [ ] `GET /api/items/:id/evidence` returns source email ref, attachment ref+sha256, extracted fields, confidence, prior rule (if any), QBO link (if posted).
- [ ] `GET /api/audit` returns audit events (read-only) for the tenant.
- [ ] Cross-tenant access returns `404 NOT_FOUND` (never foreign rows).
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/today | Digest + exception/posted/held/failed counts + item list |
| GET | /api/exceptions | Exception queue (filter by status) |
| GET | /api/exceptions/:id | Single exception detail |
| GET | /api/transactions | Transaction list |
| GET | /api/transactions/:id | Transaction detail |
| GET | /api/items/:id/evidence | Full evidence chain for an item |
| GET | /api/audit | Read audit trail |

## Database Changes

No schema changes in this chunk (reuses existing tables + `v_proposal_review`).

## Test Scenarios

- **Happy path**: authenticated GET /api/today returns counts matching the DB for that tenant.
- **Edge case**: evidence for an item missing an attachment returns available fields + "missing: attachment".
- **Failure case**: user A requests user B's item id → 404, zero B rows.
- **Integration**: evidence shape feeds the Evidence panel component in CHUNK_5_FRONTEND.

## Dependencies

- **Requires**: CHUNK_1_AUTH
- **Blocks**: CHUNK_5_FRONTEND

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_3_READ</promise>
