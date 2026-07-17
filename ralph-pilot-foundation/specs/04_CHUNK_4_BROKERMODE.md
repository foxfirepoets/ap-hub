# CHUNK_4_BROKERMODE: Rewire ap-hub to use the broker, keys optional, proof calls fail-closed

## Summary

Make ap-hub call the broker instead of holding keys locally, while proving guarantee 5 survives the new hop. `ANTHROPIC_API_KEY`/`SWARMSYNC_API_KEY` become optional (broker mode) but still work (direct mode, for the dev box + existing tests). The load-bearing deliverable is `test/broker-fail-safe.test.ts`: every broker-outage shape must HOLD, never fail open.

## Acceptance Criteria

- [ ] `src/config.ts`: add `BROKER_BASE_URL` (validated `https://`, except `http://127.0.0.1` in tests) + `BROKER_INSTALL_TOKEN`; `ANTHROPIC_API_KEY`/`SWARMSYNC_API_KEY` become optional. `QBO_ENV=production` still hard-refused (guarantee 3 unchanged).
- [ ] `src/broker/BrokerClient` (host-neutral); `getBrokerExtractor()` implements the existing `Extractor` interface (`src/extract/model.ts:23`); `src/pipeline/extract.ts` selects broker vs direct by config; `src/services.ts` points `SwarmSyncClient` at the broker in broker mode.
- [ ] `boot()` succeeds with **no** `ANTHROPIC_API_KEY` present when `BROKER_BASE_URL` is set; an extraction completes end-to-end via the broker.
- [ ] **`test/broker-fail-safe.test.ts` — all four cases HOLD:** broker 500 on `/api/verify` → hold + `exceptions` row, nothing reaches `ready`; broker connection refused → hold; broker `200` with empty/malformed body → held, **not** treated as a pass; broker cannot emit a 2xx on an upstream error (broker-side unit).
- [ ] Existing `proof_fail_safe`, `gatekeeper_hold`, `proof_gate_posting`, `no_prod_write` tests pass **unmodified**.
- [ ] `src/logger.ts` redaction extended to `aph_` install tokens + bank/routing patterns.
- [ ] Full suite ≥ 212, zero existing tests modified.
- [ ] All tests pass with zero failures.

## Endpoints / Interfaces

No new HTTP endpoints — ap-hub becomes a client of the CHUNK_3 broker routes. `Extractor` interface reused unchanged.

## Database Changes

No schema changes in this chunk.

## Test Scenarios

- **Happy path**: broker-mode extraction + proof both succeed → identical pipeline behavior to direct mode.
- **Edge case**: `BROKER_BASE_URL` set, `ANTHROPIC_API_KEY` absent → boots and extracts.
- **Failure case**: the four broker-outage shapes → every one HOLDS; a malformed-200 proof is never a pass.
- **Integration**: sets up the connector interface (CHUNK_5) which posts through the same fail-closed pipeline.

## Dependencies

- **Requires**: CHUNK_3_BROKERPROXY
- **Blocks**: CHUNK_5_CONNECTOR

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_4_BROKERMODE</promise>
