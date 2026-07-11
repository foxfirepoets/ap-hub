# CHUNK_2_AUTH: Implement encrypted OAuth for Gmail-readonly plus QBO read-only with confirm-realm

## Summary

Adds the two identities the service needs and nothing more: Gmail OAuth at `gmail.readonly` scope, and QuickBooks Online OAuth used strictly for reading reference lists (accounting scope, no writes). Tokens are encrypted at rest, refresh is handled (persisting Intuit's rotated refresh token every time), and QBO connect performs a confirm-realm check by reading CompanyInfo and asserting the expected sandbox company name. This chunk deliberately implements ZERO QBO write capability — creating/updating/deleting QBO entities does not exist until CHUNK_7. (Gmail `send` scope is NOT added here — CHUNK_4's gatekeeper adds it with its lockdown; this chunk stays read-only.)

## Acceptance Criteria

- [ ] Gmail OAuth flow completes at `gmail.readonly` scope only; access + refresh tokens stored encrypted (AES via ENCRYPTION_KEY) in oauth_tokens; tokens never appear in logs.
- [ ] QBO OAuth flow completes for the sandbox realm; on callback it reads CompanyInfo and stores the realm only if the company name matches `QBO_SANDBOX_COMPANY_NAME` (else it errors, does not store).
- [ ] Token refresh works for both providers; on QBO refresh the newest rotated refresh token is persisted; a 401 triggers refresh, and on repeated failure raises an `auth_failure` exception and pauses that tenant.
- [ ] A read-only QBO client can query CompanyInfo and one list endpoint (e.g. vendors) — and the codebase contains NO create/update/delete method for QBO (grep-verifiable; enforced by a test).
- [ ] `npm run cli -- connect gmail` and `connect qbo --env sandbox` initiate the flows; `cli -- env` prints the active realm (must say sandbox).
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|--------|------|-------------|
| GET | /oauth/gmail/callback | Gmail OAuth redirect handler |
| GET | /oauth/qbo/callback | QBO OAuth redirect handler (runs confirm-realm) |

## Database Changes

- `oauth_tokens`: populated (rows written); no schema change (table created in CHUNK_1).
- `exceptions`: `auth_failure` rows may be written.

## Test Scenarios

- **Happy path**: Gmail + QBO sandbox connect; tokens encrypted; CompanyInfo readable.
- **Edge case**: QBO callback where CompanyInfo name != configured sandbox company → connection refused, no token stored.
- **Failure case**: expired token → refresh; persistent 401 → `auth_failure` exception + tenant paused; no token/secret in any log line (grep assertion).
- **Integration**: the read-only QBO client returns a vendor list that CHUNK_6 will map against; `no_qbo_write` test asserts no write method is reachable.

## Dependencies

- **Requires**: CHUNK_1_INFRA.
- **Blocks**: CHUNK_3_INGEST (needs Gmail token), CHUNK_4_GATEKEEPER (needs the Gmail identity), CHUNK_6_MAPPING (needs QBO lists).

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_2_AUTH</promise>
