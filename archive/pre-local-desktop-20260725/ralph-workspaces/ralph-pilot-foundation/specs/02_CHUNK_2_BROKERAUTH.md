# CHUNK_2_BROKERAUTH: Stand up the broker service skeleton with per-install token auth

## Summary

Build the new `broker/` service (Node 20, `node:http`, Zod, Pino — mirroring `src/http.ts` and the repo's migration-runner pattern) with its own Postgres schema and per-install bearer-token authentication. This is the credential-custody foundation: every later broker route sits behind this auth. Auth is its own chunk so its isolation is provable before any upstream proxying exists.

## Acceptance Criteria

- [ ] `broker/migrations/001_init.sql` creates `installs`, `heartbeats`, `spend_ledger` (per SPEC §6); UP→DOWN→UP is clean on a scratch DB; the verification query returns 3.
- [ ] Tokens are 32-byte `crypto.randomBytes`, base64url, prefixed `aph_`, stored as SHA-256, compared in constant time, shown once at issue.
- [ ] Operator CLI: `issue-token --install <label> [--cap-usd]`, `revoke --install <label> | --all`, `list-installs`.
- [ ] Auth matrix: no header → **401 UNAUTHENTICATED**; unknown token → 401; revoked token → **403 TOKEN_REVOKED**; valid → 200. Error shape `{"error":{"code":"…"}}`.
- [ ] `GET /health` returns 200 `{status:"ok",db:true}` (or 503 when DB down), no auth.
- [ ] Broker logs redact `aph_` tokens (Pino redaction).
- [ ] Existing ap-hub suite still 212, zero existing tests modified.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Liveness (db reachable), no auth |
| (all other broker routes) | — | Require `Authorization: Bearer aph_…`; added in CHUNK_3 |

## Database Changes

- `installs`: one row per pilot machine (id, label, token_sha256, revoked_at, weekly_cap_usd, timestamps) (NEW, broker DB)
- `heartbeats`: liveness telemetry, closed `event` enum, `detail` ≤200 chars (NEW, broker DB)
- `spend_ledger`: per-install upstream spend for the cap (NEW, broker DB)

## Test Scenarios

- **Happy path**: `issue-token` then an authed request → 200.
- **Edge case**: constant-time compare on unknown vs known-bad token; both 401, no timing leak in the code path.
- **Failure case**: revoked token → 403 within one request; broker DB down → `/health` 503.
- **Integration**: the auth middleware + `installs` table are consumed by every CHUNK_3 proxy route.

## Dependencies

- **Requires**: CHUNK_1_BASELINE
- **Blocks**: CHUNK_3_BROKERPROXY, CHUNK_4_BROKERMODE

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_2_BROKERAUTH</promise>
