# CHUNK_3_BROKERPROXY: Proxy Claude + SwarmSync through the broker, fail-closed, with spend caps

## Summary

Add the four upstream-proxy routes that let the broker hold Ben's keys and call Claude + SwarmSync on an install's behalf, plus the per-install rate limit and hard weekly spend cap. This is the highest-risk chunk: the broker sits in front of a proof service, so it must **fail closed** — never turn any upstream failure into a success. Pass-through fidelity is absolute.

## Acceptance Criteria

- [ ] `POST /v1/extract` → Anthropic (broker key); `POST /api/verify`, `POST /api/scan/invoices`, `GET /api/proof/:id/export/verify` → SwarmSync (broker key). SwarmSync paths mirrored **exactly** so `SwarmSyncClient` needs no code change.
- [ ] **Pass-through fidelity:** upstream body returned byte-identical; an upstream non-2xx **never** becomes a 2xx (`502 UPSTREAM_FAILED`). No cached proofs, no default-pass, no graceful degradation.
- [ ] **Fail-closed:** broker DB unreachable → 503 and the upstream mock is **not** called (can't check revocation/cap → don't call).
- [ ] Spend cap: at cap → **429 SPEND_CAP_EXCEEDED** with `Retry-After`, and the upstream mock is called **0 times** (assert call count).
- [ ] Rate limit: 61st req/min/install → **429 RATE_LIMITED**; `/v1/heartbeat` limited separately (added CHUNK_6).
- [ ] Malformed request body → **400 VALIDATION** (Zod paths only, never values).
- [ ] `revoke --all` kill switch stops all spending within one request.
- [ ] Existing ap-hub suite still 212, zero existing tests modified.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/extract | Proxy Anthropic; returns raw model JSON verbatim |
| POST | /api/verify | Proxy SwarmSync Verify-API/AuditProof |
| POST | /api/scan/invoices | Proxy SwarmSync InvoiceProof |
| GET | /api/proof/:id/export/verify | Proxy SwarmSync chain verify |

## Database Changes

- `spend_ledger`: written on each upstream call (est_usd); read for the weekly-cap check (uses index from CHUNK_2). No new tables.

## Test Scenarios

- **Happy path**: authed extract → Anthropic mock → verbatim JSON back.
- **Edge case**: upstream returns a well-formed `200` with an empty body → broker passes it through as-is (the pipeline's fail-closed handling lives in CHUNK_4; the broker never fabricates).
- **Failure case**: upstream 500/timeout → 502, never 2xx; DB down → 503, no upstream call; at cap → 429, no upstream call.
- **Integration**: CHUNK_4 points ap-hub at these routes and asserts the pipeline holds on every failure shape.

## Dependencies

- **Requires**: CHUNK_2_BROKERAUTH
- **Blocks**: CHUNK_4_BROKERMODE

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_3_BROKERPROXY</promise>
