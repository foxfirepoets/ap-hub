# CHUNK_2_AUTH: Restrict product access to the installing Windows user on loopback

## Summary

This chunk removes hosted Google SSO as the local product access authority. It binds both
application processes to loopback and establishes a SID-bound, nonce-bootstrapped local owner
session while preserving all tenant and role authorization checks.

## Acceptance Criteria

- [ ] Backend and UI listen only on `127.0.0.1` or `::1`.
- [ ] Non-loopback Host, forwarded-host, and foreign Origin requests fail with `LOCAL_ONLY`.
- [ ] A one-time bootstrap nonce creates one HttpOnly SameSite=Strict owner session.
- [ ] Expired/replayed nonce, SID mismatch, and CSRF attempts fail closed.
- [ ] Google SSO is not required to open the installed local product.
- [ ] Existing tenant and role isolation tests remain green.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|---|---|---|
| POST | `/api/local-session/bootstrap` | Exchange a one-time local nonce for an owner session |
| GET | `/health` | Loopback-only non-sensitive process health |

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: installer launch URL bootstraps the installed owner once.
- **Edge case**: a second browser tab reuses the valid session without a second identity.
- **Failure case**: foreign Host/Origin, wrong SID, and nonce replay are refused.
- **Integration**: authenticated local sessions continue through existing API RBAC.

## Dependencies

- **Requires**: CHUNK_1_SECRETS
- **Blocks**: CHUNK_3_GMAIL, CHUNK_4_TRANSPORTS, CHUNK_6_WATCHDOG

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_2_AUTH</promise>
