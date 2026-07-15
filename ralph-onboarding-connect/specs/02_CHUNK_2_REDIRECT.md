# CHUNK_2_REDIRECT: Redirect capability in the plain HTTP server; wire signed state + redirect into the OAuth callbacks

## Summary

`src/http.ts`'s `respond(status, body)` currently always writes `content-type: application/json` — there's no way for a route to issue a 302 redirect. This chunk adds that capability, then wires it (plus CHUNK_1's `verifyConnectState`) into the EXISTING, unchanged Gmail/QBO OAuth callback handlers: on success, redirect back to the onboarding page instead of returning bare JSON; on a forged/expired state, refuse before ever calling the token-exchange functions. The actual OAuth exchange logic (`exchangeGmailCode`, `exchangeQboCode`, `assertExpectedCompany`, `saveToken`) is NOT modified — only what happens to the HTTP response.

## Acceptance Criteria

- [ ] `src/http.ts`'s `Route`/`respond` mechanism supports issuing a 302 redirect with a `Location` header, alongside the existing JSON-body path (`/health` and any other existing JSON responses must keep working unchanged).
- [ ] `handleGmailCallback`/`handleQboCallback` call `verifyConnectState(state)` FIRST, before touching `code` or calling any exchange function; an invalid/expired/tampered state returns 400 and calls no exchange/save function.
- [ ] On success, both handlers redirect (302) to `${WEB_BASE_URL}/onboarding?connected=gmail` / `?connected=qbo` instead of `respond(200, {...})`.
- [ ] On a handled failure (missing code, exchange failure, QBO confirm-realm mismatch), both handlers redirect to `${WEB_BASE_URL}/onboarding?connect_error=gmail|qbo&reason=<code>` instead of `respond(400, {...})`.
- [ ] The existing `assertExpectedCompany` confirm-realm check still refuses to save a mismatched company's token — unchanged behavior, only the response path changed.
- [ ] The redirect target is ALWAYS server-constructed from `config().WEB_BASE_URL` plus a fixed path/query shape — never built from any user-supplied input (no open-redirect surface).
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

`GET /oauth/gmail/callback` and `GET /oauth/qbo/callback` (existing paths, plain HTTP server) — response shape changes from JSON body to a redirect; request shape unchanged (`?code=...&state=...` plus QBO's `&realmId=...`).

## Database Changes

No schema changes in this chunk. `oauth_tokens` writes (`saveToken`) are unchanged — same calls, same data.

## Test Scenarios

- **Happy path**: valid code + valid signed state → token saved (unchanged assertion from any existing test) AND a 302 to `.../onboarding?connected=gmail` (or `qbo`) is observed.
- **Edge case**: QBO connect to a company that doesn't match `QBO_SANDBOX_COMPANY_NAME` → no token saved (existing behavior) AND a 302 to `.../onboarding?connect_error=qbo&reason=wrong_company` (or similar reason code) is observed, never a `connected=qbo` redirect.
- **Failure case**: forged/tampered/expired state → 400, no exchange function called (verify via a spy/mock that `exchangeGmailCode`/`exchangeQboCode` was never invoked), no token saved, no success redirect issued.
- **Integration**: reuses CHUNK_1's `verifyConnectState` unchanged; CHUNK_4's start routes are the only producer of a valid signed state these handlers will accept.

## Dependencies

- **Requires**: CHUNK_1_STATETOKEN.
- **Blocks**: CHUNK_5_PAGEREDESIGN (the page needs `?connected=`/`?connect_error=` to actually be reachable to build against).

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_2_REDIRECT</promise>
