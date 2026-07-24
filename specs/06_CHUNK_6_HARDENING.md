# CHUNK_6_HARDENING: Prove safety across the completed build

## Summary

This chunk aligns configuration, installer, documentation, monitoring, and verification with the implemented product. It runs adversarial checks for duplicate writes, tenant leaks, Gmail sending, capability overclaims, migration recovery, and external-certification honesty.

## Acceptance Criteria

- [ ] Env examples/installers include draft, QBD identity/write-enable, and lease settings with safe defaults.
- [ ] Health/metrics expose provider queue age, uncertain results, statement failures, and draft failures without secrets.
- [ ] Migration backup/restore and rollback instructions are executable and honest.
- [ ] Hostile scans find no proof bypass, direct provider writer in core, general reply send, or unsupported-edition overclaim.
- [ ] Full repository and broker gates pass; live external checks remain separately labeled.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

Extends existing health/diagnostic responses only; no new mutation endpoint.

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: clean install/config validates and full verification passes.
- **Edge case**: connector offline, live credentials absent, and capability unsupported are reported honestly.
- **Failure case**: secret-shaped diff, general Gmail send, proof bypass, or production-write attempt fails the gate.
- **Integration**: application, broker, web build, UI contracts, Compose, and PowerShell syntax pass together.

## Dependencies

- **Requires**: CHUNK_2_QBD, CHUNK_3_STATEMENTS, CHUNK_4_DRAFTS, CHUNK_5_PRODUCT
- **Blocks**: None

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_6_HARDENING</promise>
