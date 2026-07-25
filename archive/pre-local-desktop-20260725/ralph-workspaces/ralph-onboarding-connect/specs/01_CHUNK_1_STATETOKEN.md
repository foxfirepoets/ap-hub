# CHUNK_1_STATETOKEN: Signed, time-boxed CSRF state token for the Gmail/QBO OAuth connect flow

## Summary

Today the OAuth `state` param on both the Gmail and QBO connect callbacks is just the raw tenant id (`Number(url.searchParams.get('state') ?? '1')`) — trivially forgeable, and the CLI's `connect qbo` command even hardcodes `state=1`. Because the new "start" redirect (Next.js, session-gated) and the existing callback (plain HTTP server, a different port) are two separate processes, the existing same-origin-cookie CSRF pattern used by the login SSO flow can't be reused directly. This chunk builds a stateless, signed, time-boxed alternative both sides can use without sharing a cookie. It hands off `signConnectState`/`verifyConnectState` to CHUNK_2 (the callback wiring) and CHUNK_4 (the start routes).

## Acceptance Criteria

- [ ] `signConnectState(tenantId: number): string` and `verifyConnectState(token: string): { tenantId: number } | null` exist in `src/auth/connect-state.ts`.
- [ ] A token signed for tenant N verifies back to tenant N.
- [ ] A tampered token (any byte changed) fails verification (`null`).
- [ ] A token older than 5 minutes fails verification (`null`).
- [ ] A token signed with a different `SESSION_COOKIE_SECRET` fails verification (`null`).
- [ ] No DB access, no fetch — pure, deterministic given the same secret/clock.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No HTTP endpoints — internal helper only. Signature: HMAC-SHA256 over `tenantId + '.' + timestamp + '.' + nonce`, keyed by `config().SESSION_COOKIE_SECRET` (existing config value — no new secret introduced).

## Database Changes

No schema changes in this chunk. The token is never persisted — stateless by design.

## Test Scenarios

- **Happy path**: sign for tenant 7, verify immediately → `{ tenantId: 7 }`.
- **Edge case**: verify a token signed 4 minutes 59 seconds ago → still valid; 5 minutes 1 second ago → `null`. (Inject a clock/now function for testability — do not depend on real wall-clock sleeps in the test.)
- **Failure case**: flip one character of a valid token → `null`. Sign with secret A, verify with secret B → `null`.
- **Integration**: CHUNK_2's callback handlers and CHUNK_4's start routes both import this module directly — no duplicated signing logic.

## Dependencies

- **Requires**: None (first chunk).
- **Blocks**: CHUNK_2_REDIRECT, CHUNK_4_STARTROUTES.

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_1_STATETOKEN</promise>
