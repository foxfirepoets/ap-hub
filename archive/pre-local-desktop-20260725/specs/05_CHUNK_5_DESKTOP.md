# CHUNK_5_DESKTOP: Preserve durable local QuickBooks Desktop posting

## Summary

This chunk reconciles the existing QBWC/qbXML implementation with the local-only runtime and the
shared provider contract. It proves company-bound durable jobs survive restart and cannot be
leased or replayed across connections.

## Acceptance Criteria

- [ ] QBWC remains loopback-local and no QBD data uses a hosted relay.
- [ ] Approved jobs survive process restart and lease only to the bound tenant/connection/company.
- [ ] BillAdd results require authoritative BillQuery read-back before local finalization.
- [ ] Wrong-company, malformed response, expired lease, and uncertain outcome remain held safely.
- [ ] QBD write controls remain explicit and disabled by default.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|---|---|---|
| POST | `/qbwc` | Existing local SOAP polling endpoint |
| GET | `/api/provider-jobs` | Existing authenticated durable job view |

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: disposable company leases, posts, reads back, and reconciles one bill.
- **Edge case**: restart between enqueue, lease, response, and read-back.
- **Failure case**: wrong company and cross-tenant lease attempts never receive a write request.
- **Integration**: QBD satisfies the same posting guarantees as CHUNK_4.

## Dependencies

- **Requires**: CHUNK_1_SECRETS, CHUNK_2_AUTH
- **Blocks**: CHUNK_7_CERTIFICATION

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_5_DESKTOP</promise>
