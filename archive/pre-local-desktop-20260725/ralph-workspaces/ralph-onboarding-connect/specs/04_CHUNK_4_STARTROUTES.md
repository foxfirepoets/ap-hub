# CHUNK_4_STARTROUTES: Session-gated Next.js routes that redirect into the real Gmail/QBO OAuth consent flow

## Summary

Adds the two entry points the wizard's "Connect" buttons actually link to: `GET /api/connections/gmail/start` and `GET /api/connections/qbo/start`. Each verifies an owner session, builds the real provider authorize URL (extracting the URL-shape already inline in `src/cli.ts`'s `connect` command into one shared helper both the CLI and these routes call — no duplicated logic), signs a CHUNK_1 state token, and 302-redirects. No token exchange happens here — that's still the callback's job (CHUNK_2), unchanged process split per the documented architecture.

## Acceptance Criteria

- [ ] `GET /api/connections/gmail/start` exists, requires an `owner_controller` session (401 if none, 403 if wrong role), and 302-redirects to a real Google OAuth consent URL containing `client_id`, `redirect_uri` (from config, now `:3001` per CHUNK_3), `scope=gmail.readonly`, and a `state` produced by CHUNK_1's `signConnectState(tenantId)` using the SESSION-RESOLVED tenant id (never a client-supplied one).
- [ ] `GET /api/connections/qbo/start` — same shape, Intuit's authorize URL, `scope=com.intuit.quickbooks.accounting`.
- [ ] `buildGmailAuthorizeUrl(cfg, state)` / `buildQboAuthorizeUrl(cfg, state)` are extracted as shared functions; `src/cli.ts`'s `connect` command is updated to call the SAME functions instead of its own inline string-building (the CLI keeps working, now via the shared helper — no behavior change to the CLI's printed URL other than a real state value on the QBO one instead of the currently-hardcoded `state=1`).
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/connections/gmail/start | Session-gated (owner_controller); 302 to Google OAuth consent |
| GET | /api/connections/qbo/start | Session-gated (owner_controller); 302 to Intuit OAuth consent |

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: an owner session hitting either route gets a 302 whose `Location` contains the correct `client_id`/`redirect_uri`/`scope` and a `state` that `verifyConnectState` (CHUNK_1) can successfully decode back to that session's real tenant id.
- **Edge case**: a `bookkeeper`/`cpa` session hitting either route → 403, no redirect to any OAuth provider.
- **Failure case**: no session at all → 401.
- **Integration**: `src/cli.ts`'s `connect gmail|qbo` command still works and now uses the shared URL-builder — run it manually or via an existing CLI test if one exists, confirm the printed URL shape is unchanged apart from a real (not hardcoded) state value.

## Dependencies

- **Requires**: CHUNK_1_STATETOKEN (for signing), CHUNK_3_CONFIG (for correct redirect_uri).
- **Blocks**: CHUNK_5_PAGEREDESIGN (the "Connect" buttons link here).

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_4_STARTROUTES</promise>
